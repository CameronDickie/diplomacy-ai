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

func TestNorwayFleetRetreatUsesCanonicalStPetersburgCoast(t *testing.T) {
	input := fixtureRequest()
	input.Units = []unitInput{
		{ID: "attacker", Type: "FLEET", Power: "ENGLAND", Territory: "NTH"},
		{ID: "supporter", Type: "FLEET", Power: "ENGLAND", Territory: "NWG"},
		{ID: "defender", Type: "FLEET", Power: "RUSSIA", Territory: "NOR"},
	}
	input.Orders = []orderInput{
		{Type: "MOVE", UnitTerritory: "NTH", TargetTerritory: "NOR"},
		{Type: "SUPPORT_MOVE", UnitTerritory: "NWG", SupportedUnit: "NTH", SupportedDestination: "NOR"},
	}
	resolved, err := adjudicate(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Dislodged) != 1 {
		t.Fatalf("expected one dislodged fleet: %#v", resolved.Dislodged)
	}
	stp := []retreatOption{}
	for _, option := range resolved.Dislodged[0].RetreatOptions {
		if option.Territory == "STP" {
			stp = append(stp, option)
		}
	}
	if len(stp) != 1 || stp[0].Coast != "NORTH" {
		t.Fatalf("expected exactly STP/NORTH, not an unqualified alias: %#v", stp)
	}
	input.Phase = "RETREATS"
	input.Units = nil
	input.Orders = nil
	for _, unit := range resolved.Units {
		input.Units = append(input.Units, unitInput{ID: unit.ID, Type: unit.Type, Power: unit.Power, Territory: unit.Territory, Coast: unit.Coast})
	}
	input.Dislodged, input.RetreatContext = resolved.Dislodged, resolved.RetreatContext
	if errors := validateBoard(input); len(errors) != 0 {
		t.Fatal(errors)
	}
	// Serialization has only canonical destinations; it must not grant the southern coast.
	input.Dislodged[0].RetreatOptions = append(input.Dislodged[0].RetreatOptions, retreatOption{Territory: "STP", Coast: "SOUTH"})
	if len(validateBoard(input)) == 0 {
		t.Fatal("accepted unreachable STP/SOUTH retreat")
	}
}
