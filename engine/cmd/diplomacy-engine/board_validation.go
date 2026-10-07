package main

import (
	"fmt"
	"reflect"
	"sort"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

// Fixture validation is read-only. In particular SetUnits alone does not check
// terrain, coast or nation, so validate those against Godip's graph first.
func validateBoard(input request) []string {
	errors := []string{}
	add := func(path, message string) { errors = append(errors, path+": "+message) }
	season := godip.Spring
	if input.Season == "FALL" || input.Season == "WINTER" {
		season = godip.Fall
	}
	phase := godip.Movement
	if input.Phase == "RETREATS" {
		phase = godip.Retreat
	}
	if input.Phase == "BUILDS" {
		phase = godip.Adjustment
	}
	state := classical.Blank(classical.NewPhase(input.Year, season, phase))
	graph := state.Graph()
	provinceOK := func(name string) bool {
		p := toGodipProvince(name)
		return name != "" && graph.Has(p) && p.Sub() == "" && fromGodipProvince(p) == name
	}
	nationOK := func(name string) bool {
		for _, n := range graph.Nations() {
			if fromGodipNation(n) == name {
				return true
			}
		}
		return false
	}
	if input.Year < 1 || input.Year > 9999 {
		add("year", "must be between 1 and 9999")
	}
	if (input.Phase != "ORDERS" && input.Phase != "RETREATS" && input.Phase != "BUILDS") ||
		(input.Phase == "BUILDS" && input.Season != "WINTER") ||
		(input.Phase != "BUILDS" && input.Season != "SPRING" && input.Season != "FALL") {
		add("phase", "inconsistent phase/season")
	}
	units, dislodgeds := map[godip.Province]godip.Unit{}, map[godip.Province]godip.Unit{}
	ids := map[string]bool{}
	check := func(unit unitInput, path string, target map[godip.Province]godip.Unit) {
		if unit.ID == "" || ids[unit.ID] {
			add(path+".id", "must be nonempty and unique")
		}
		ids[unit.ID] = true
		if !provinceOK(unit.Territory) {
			add(path+".territory", "unknown province")
			return
		}
		p := toGodipLocation(unit.Territory, unit.Coast)
		if unit.Coast != "" && fromGodipCoast(p.Sub()) != unit.Coast {
			add(path+".coast", "unknown coast")
			return
		}
		if !graph.Has(p) {
			add(path+".coast", "coast does not exist on this province")
			return
		}
		if !nationOK(unit.Power) {
			add(path+".power", "unknown power")
		}
		if unit.Type == "ARMY" {
			if unit.Coast != "" || !graph.Flags(p)[godip.Land] {
				add(path, "army must occupy land without a coast suffix")
			}
		} else if unit.Type == "FLEET" {
			if !graph.Flags(p)[godip.Sea] {
				add(path, "fleet requires sea/coastal terrain and an explicit coast on split-coast provinces")
			}
		} else {
			add(path+".type", "unknown unit type")
		}
		for existing := range target {
			if existing.Super() == p.Super() {
				add(path+".territory", "duplicate occupancy")
			}
		}
		target[p] = godip.Unit{Type: toGodipUnitType(unit.Type), Nation: toGodipNation(unit.Power)}
	}
	for i, unit := range input.Units {
		check(unit, fmt.Sprintf("units[%d]", i), units)
	}
	for i, unit := range input.Dislodged {
		check(unitInput{ID: unit.ID, Type: unit.Type, Power: unit.Power, Territory: unit.Territory, Coast: unit.Coast}, fmt.Sprintf("dislodged[%d]", i), dislodgeds)
	}
	centers := map[godip.Province]godip.Nation{}
	for name, power := range input.SupplyCenters {
		p := toGodipProvince(name)
		if !provinceOK(name) || graph.SC(p) == nil {
			add("supplyCenters."+name, "not a supply center")
		}
		if power != "" && !nationOK(power) {
			add("supplyCenters."+name, "unknown owner")
		}
		if power == "" {
			centers[p] = godip.Neutral
		} else {
			centers[p] = toGodipNation(power)
		}
	}
	for _, p := range graph.AllSCs() {
		if _, ok := centers[p]; !ok {
			add("supplyCenters", "missing "+fromGodipProvince(p))
		}
	}
	dislodgers, bounces := map[godip.Province]godip.Province{}, map[godip.Province]map[godip.Province]bool{}
	if input.Phase == "RETREATS" {
		if len(input.Dislodged) == 0 || input.RetreatContext == nil {
			add("retreatContext", "retreats require dislodged units and complete retreat context")
		}
	} else if len(input.Dislodged) > 0 || input.RetreatContext != nil {
		add("retreatContext", "retreat metadata is only valid during retreats")
	}
	if input.RetreatContext != nil {
		victims := map[string]bool{}
		for attacker, victim := range input.RetreatContext.Dislodgers {
			if !provinceOK(attacker) || !provinceOK(victim) || attacker == victim {
				add("retreatContext.dislodgers", "invalid attacker/victim province")
			}
			if victims[victim] {
				add("retreatContext.dislodgers", "a unit can only have one dislodger")
			}
			victims[victim] = true
			dislodgers[toGodipProvince(attacker)] = toGodipProvince(victim)
		}
		for destination, sources := range input.RetreatContext.Bounces {
			if !provinceOK(destination) || len(sources) == 0 {
				add("retreatContext.bounces", "invalid destination or empty sources")
			}
			set := map[godip.Province]bool{}
			for _, source := range sources {
				p := toGodipProvince(source)
				if !provinceOK(source) || set[p] || source == destination {
					add("retreatContext.bounces", "invalid/duplicate source")
				}
				set[p] = true
			}
			bounces[toGodipProvince(destination)] = set
		}
	}
	if len(errors) > 0 {
		sort.Strings(errors)
		return errors
	}
	state.Load(units, centers, dislodgeds, dislodgers, bounces, map[godip.Province]godip.Adjudicator{})
	for i, unit := range input.Dislodged {
		path := fmt.Sprintf("dislodged[%d]", i)
		p := toGodipLocation(unit.Territory, unit.Coast)
		// Godip records retreat-blocking origins, not every attack: a convoyed
		// attack deliberately permits retreat to its origin (orders.move.Execute).
		if unit.DislodgedBy != "" {
			victim, ok := dislodgers[toGodipProvince(unit.DislodgedBy)]
			if !ok || victim != p.Super() {
				add(path+".dislodgedBy", "must match the recorded dislodger")
			}
		} else {
			for _, victim := range dislodgers {
				if victim.Super() == p.Super() {
					add(path+".dislodgedBy", "cannot omit a recorded dislodger")
				}
			}
		}
		if occupant, _, found := state.Unit(p); !found || occupant.Nation == toGodipNation(unit.Power) {
			add(path, "dislodged unit needs an enemy occupying its former province")
		}
		actual := retreatOptions(state, p)
		expected := append([]retreatOption{}, unit.RetreatOptions...)
		sort.Slice(expected, func(i, j int) bool {
			if expected[i].Territory == expected[j].Territory {
				return expected[i].Coast < expected[j].Coast
			}
			return expected[i].Territory < expected[j].Territory
		})
		if len(actual) == 0 || !reflect.DeepEqual(actual, expected) {
			add(path+".retreatOptions", "does not match Godip legal retreats")
		}
	}
	sort.Strings(errors)
	return errors
}

func fromGodipNation(n godip.Nation) string {
	switch n {
	case godip.Austria:
		return "AUSTRIA"
	case godip.England:
		return "ENGLAND"
	case godip.France:
		return "FRANCE"
	case godip.Germany:
		return "GERMANY"
	case godip.Italy:
		return "ITALY"
	case godip.Russia:
		return "RUSSIA"
	case godip.Turkey:
		return "TURKEY"
	}
	return ""
}
