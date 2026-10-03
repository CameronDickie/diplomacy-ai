package main

import (
	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
	"testing"
)

func fixtureRequest() request {
	input := request{Year: 1901, Season: "SPRING", Phase: "ORDERS", SupplyCenters: map[string]string{}, Units: []unitInput{{ID: "fleet", Type: "FLEET", Power: "RUSSIA", Territory: "STP", Coast: "SOUTH"}}}
	graph := classical.Blank(classical.NewPhase(1901, godip.Spring, godip.Movement)).Graph()
	for _, p := range graph.AllSCs() {
		input.SupplyCenters[fromGodipProvince(p)] = ""
	}
	return input
}

func TestFixtureValidationChecksGraphRatherThanOnlySetUnits(t *testing.T) {
	if errors := validateBoard(fixtureRequest()); len(errors) > 0 {
		t.Fatal(errors)
	}
	cases := []struct {
		name   string
		change func(*request)
	}{
		{"fleet inland", func(r *request) { r.Units[0].Territory = "PAR"; r.Units[0].Coast = "" }},
		{"missing coast", func(r *request) { r.Units[0].Coast = "" }},
		{"wrong coast", func(r *request) { r.Units[0].Coast = "WEST" }},
		{"army sea", func(r *request) { r.Units[0].Type = "ARMY"; r.Units[0].Territory = "NTH"; r.Units[0].Coast = "" }},
		{"unknown nation", func(r *request) { r.Units[0].Power = "OTHER" }},
		{"duplicate occupancy", func(r *request) {
			r.Units = append(r.Units, unitInput{ID: "other", Type: "FLEET", Power: "ENGLAND", Territory: "STP", Coast: "NORTH"})
		}},
		{"missing center", func(r *request) { delete(r.SupplyCenters, "TUN") }},
		{"not a center", func(r *request) { r.SupplyCenters["NTH"] = "ENGLAND" }},
		{"wrong season", func(r *request) { r.Season = "WINTER" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := fixtureRequest()
			c.change(&r)
			if len(validateBoard(r)) == 0 {
				t.Fatal("accepted invalid fixture")
			}
		})
	}
}

func TestAdjudicatedRetreatContextReconstructsGodipLegalRetreats(t *testing.T) {
	input := fixtureRequest()
	input.Units = []unitInput{{ID: "attack", Type: "ARMY", Power: "FRANCE", Territory: "PAR"}, {ID: "support", Type: "ARMY", Power: "FRANCE", Territory: "MAR"}, {ID: "defender", Type: "ARMY", Power: "GERMANY", Territory: "BUR"}}
	input.Orders = []orderInput{{Type: "MOVE", UnitTerritory: "PAR", TargetTerritory: "BUR"}, {Type: "SUPPORT_MOVE", UnitTerritory: "MAR", SupportedUnit: "PAR", SupportedDestination: "BUR"}}
	resolved, err := adjudicate(input)
	if err != nil {
		t.Fatal(err)
	}
	input.Phase = "RETREATS"
	input.Units = nil
	input.Orders = nil
	for _, u := range resolved.Units {
		input.Units = append(input.Units, unitInput{ID: u.ID, Type: u.Type, Power: u.Power, Territory: u.Territory, Coast: u.Coast})
	}
	input.Dislodged = resolved.Dislodged
	input.RetreatContext = resolved.RetreatContext
	if errors := validateBoard(input); len(errors) > 0 {
		t.Fatal(errors)
	}
	input.Dislodged[0].RetreatOptions = []retreatOption{{Territory: "PAR"}}
	if len(validateBoard(input)) == 0 {
		t.Fatal("accepted retreat into attacker's origin")
	}
}
