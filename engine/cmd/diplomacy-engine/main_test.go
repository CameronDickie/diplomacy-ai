package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNoDislodgementReturnsEmptyJSONCollections(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "austria", Type: "ARMY", Power: "AUSTRIA", Territory: "VIE"},
		},
		Orders: []orderInput{
			{Type: "HOLD", UnitTerritory: "VIE"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	body := string(encoded)
	for _, expected := range []string{
		`"units":[`,
		`"dislodged":[]`,
		`"resolutions":[`,
		`"standoffs":[]`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in response %s", expected, body)
		}
	}
}

func TestEqualAttacksBounce(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "france", Type: "ARMY", Power: "FRANCE", Territory: "PAR"},
			{ID: "germany", Type: "ARMY", Power: "GERMANY", Territory: "MUN"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "PAR", TargetTerritory: "BUR"},
			{Type: "MOVE", UnitTerritory: "MUN", TargetTerritory: "BUR"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	positions := positionsByID(result.Units)
	if positions["france"] != "PAR" || positions["germany"] != "MUN" {
		t.Fatalf("expected both attacks to bounce, got %#v", positions)
	}
}

func TestHeadToHeadSwapBounces(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "france", Type: "ARMY", Power: "FRANCE", Territory: "BUR"},
			{ID: "germany", Type: "ARMY", Power: "GERMANY", Territory: "MUN"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "BUR", TargetTerritory: "MUN"},
			{Type: "MOVE", UnitTerritory: "MUN", TargetTerritory: "BUR"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	positions := positionsByID(result.Units)
	if positions["france"] != "BUR" || positions["germany"] != "MUN" {
		t.Fatalf("expected a head-to-head bounce, got %#v", positions)
	}
}

func TestThreeUnitRotationPreservesIdentity(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "one", Type: "ARMY", Power: "FRANCE", Territory: "BUR"},
			{ID: "two", Type: "ARMY", Power: "GERMANY", Territory: "RUH"},
			{ID: "three", Type: "ARMY", Power: "ITALY", Territory: "MUN"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "BUR", TargetTerritory: "RUH"},
			{Type: "MOVE", UnitTerritory: "RUH", TargetTerritory: "MUN"},
			{Type: "MOVE", UnitTerritory: "MUN", TargetTerritory: "BUR"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	positions := positionsByID(result.Units)
	if positions["one"] != "RUH" || positions["two"] != "MUN" || positions["three"] != "BUR" {
		t.Fatalf("expected all units to rotate, got %#v", positions)
	}
}

func TestSupportedAttackDislodgesDefender(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "attacker", Type: "ARMY", Power: "FRANCE", Territory: "PAR"},
			{ID: "supporter", Type: "ARMY", Power: "FRANCE", Territory: "GAS"},
			{ID: "defender", Type: "ARMY", Power: "GERMANY", Territory: "BUR"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "PAR", TargetTerritory: "BUR"},
			{
				Type:                 "SUPPORT_MOVE",
				UnitTerritory:        "GAS",
				SupportedUnit:        "PAR",
				SupportedDestination: "BUR",
			},
			{Type: "HOLD", UnitTerritory: "BUR"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	positions := positionsByID(result.Units)
	if positions["attacker"] != "BUR" {
		t.Fatalf("expected supported attack to enter BUR, got %#v", positions)
	}
	if len(result.Dislodged) != 1 || result.Dislodged[0].ID != "defender" {
		t.Fatalf("expected defender to be dislodged, got %#v", result.Dislodged)
	}
}

func TestSingleFleetConvoy(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "army", Type: "ARMY", Power: "ENGLAND", Territory: "LON"},
			{ID: "fleet", Type: "FLEET", Power: "ENGLAND", Territory: "ENG"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "LON", TargetTerritory: "BEL", ViaConvoy: true},
			{
				Type:            "CONVOY",
				UnitTerritory:   "ENG",
				SupportedUnit:   "LON",
				TargetTerritory: "BEL",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	positions := positionsByID(result.Units)
	if positions["army"] != "BEL" || positions["fleet"] != "ENG" {
		t.Fatalf("expected convoy to BEL, got %#v", positions)
	}
}

func TestRetreatOptionsPreserveSplitCoasts(t *testing.T) {
	result, err := adjudicate(request{
		Year:   1901,
		Season: "SPRING",
		Units: []unitInput{
			{ID: "attacker", Type: "FLEET", Power: "FRANCE", Territory: "ENG"},
			{ID: "supporter", Type: "FLEET", Power: "FRANCE", Territory: "IRI"},
			{ID: "defender", Type: "FLEET", Power: "GERMANY", Territory: "MAO"},
		},
		Orders: []orderInput{
			{Type: "MOVE", UnitTerritory: "ENG", TargetTerritory: "MAO"},
			{
				Type:                 "SUPPORT_MOVE",
				UnitTerritory:        "IRI",
				SupportedUnit:        "ENG",
				SupportedDestination: "MAO",
			},
			{Type: "HOLD", UnitTerritory: "MAO"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Dislodged) != 1 {
		t.Fatalf("expected one dislodged fleet, got %#v", result.Dislodged)
	}

	spainCoasts := map[string]bool{}
	for _, option := range result.Dislodged[0].RetreatOptions {
		if option.Territory == "SPA" {
			spainCoasts[option.Coast] = true
		}
	}
	if !spainCoasts["NORTH"] || !spainCoasts["SOUTH"] {
		t.Fatalf("expected both Spanish coasts, got %#v", spainCoasts)
	}
}

func TestLegalOrdersUseCanonicalFleetAdjacency(t *testing.T) {
	result, err := legalOrders(request{
		Operation: "LEGAL_ORDERS",
		Power:     "ITALY",
		Year:      1901,
		Season:    "SPRING",
		Units: []unitInput{
			{ID: "adriatic", Type: "FLEET", Power: "ITALY", Territory: "ADR"},
			{ID: "ionian", Type: "FLEET", Power: "ITALY", Territory: "ION"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if hasLegalMove(result.LegalOrders, "ADR", "GRE", "", false) {
		t.Fatal("Adriatic Sea must not be adjacent to Greece")
	}
	if !hasLegalMove(result.LegalOrders, "ADR", "ALB", "", false) {
		t.Fatal("expected Adriatic Sea to be adjacent to Albania")
	}
	if !hasLegalMove(result.LegalOrders, "ION", "GRE", "", false) {
		t.Fatal("expected Ionian Sea to be adjacent to Greece")
	}
}

func TestLegalOrdersIncludeSupportsConvoysAndFriendlyDestinations(t *testing.T) {
	supports, err := legalOrders(request{
		Operation: "LEGAL_ORDERS",
		Power:     "FRANCE",
		Year:      1901,
		Season:    "SPRING",
		Units: []unitInput{
			{ID: "paris", Type: "ARMY", Power: "FRANCE", Territory: "PAR"},
			{ID: "burgundy", Type: "ARMY", Power: "FRANCE", Territory: "BUR"},
			{ID: "gascony", Type: "ARMY", Power: "FRANCE", Territory: "GAS"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !hasLegalMove(supports.LegalOrders, "PAR", "BUR", "", false) {
		t.Fatal("expected move into a friendly occupied province to remain a legal order")
	}
	if !hasLegalOrder(supports.LegalOrders, legalOrderOutput{
		Type:                 "SUPPORT_MOVE",
		UnitTerritory:        "GAS",
		SupportedUnit:        "PAR",
		SupportedDestination: "BUR",
	}) {
		t.Fatal("expected Gascony to support Paris moving to Burgundy")
	}

	convoys, err := legalOrders(request{
		Operation: "LEGAL_ORDERS",
		Power:     "ENGLAND",
		Year:      1901,
		Season:    "SPRING",
		Units: []unitInput{
			{ID: "army", Type: "ARMY", Power: "ENGLAND", Territory: "LON"},
			{ID: "fleet", Type: "FLEET", Power: "ENGLAND", Territory: "ENG"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !hasLegalMove(convoys.LegalOrders, "LON", "BEL", "", true) {
		t.Fatal("expected London to have a convoy move to Belgium")
	}
	if !hasLegalOrder(convoys.LegalOrders, legalOrderOutput{
		Type:            "CONVOY",
		UnitTerritory:   "ENG",
		SupportedUnit:   "LON",
		TargetTerritory: "BEL",
	}) {
		t.Fatal("expected English Channel to convoy London to Belgium")
	}
}

func TestLegalOrdersPreserveSplitCoastDestinations(t *testing.T) {
	result, err := legalOrders(request{
		Operation: "LEGAL_ORDERS",
		Power:     "FRANCE",
		Year:      1901,
		Season:    "SPRING",
		Units: []unitInput{
			{ID: "fleet", Type: "FLEET", Power: "FRANCE", Territory: "MAO"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !hasLegalMove(result.LegalOrders, "MAO", "SPA", "NORTH", false) {
		t.Fatal("expected a move to Spain's north coast")
	}
	if !hasLegalMove(result.LegalOrders, "MAO", "SPA", "SOUTH", false) {
		t.Fatal("expected a move to Spain's south coast")
	}
}

func hasLegalMove(
	orders []legalOrderOutput,
	source string,
	target string,
	coast string,
	viaConvoy bool,
) bool {
	return hasLegalOrder(orders, legalOrderOutput{
		Type:            "MOVE",
		UnitTerritory:   source,
		TargetTerritory: target,
		TargetCoast:     coast,
		ViaConvoy:       viaConvoy,
	})
}

func hasLegalOrder(orders []legalOrderOutput, expected legalOrderOutput) bool {
	for _, order := range orders {
		if legalOrderSortKey(order) == legalOrderSortKey(expected) {
			return true
		}
	}
	return false
}

func positionsByID(units []unitOutput) map[string]string {
	result := make(map[string]string)
	for _, unit := range units {
		result[unit.ID] = unit.Territory
	}
	return result
}
