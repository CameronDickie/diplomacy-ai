package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/zond/godip"
	"github.com/zond/godip/orders"
	godipstate "github.com/zond/godip/state"
	"github.com/zond/godip/variants/classical"
)

type request struct {
	Operation      string            `json:"operation,omitempty"`
	Power          string            `json:"power,omitempty"`
	Year           int               `json:"year"`
	Season         string            `json:"season"`
	Units          []unitInput       `json:"units"`
	SupplyCenters  map[string]string `json:"supplyCenters"`
	Orders         []orderInput      `json:"orders"`
	Phase          string            `json:"phase,omitempty"`
	Dislodged      []unitOutput      `json:"dislodged,omitempty"`
	RetreatContext *retreatContext   `json:"retreatContext,omitempty"`
}

type unitInput struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Power     string `json:"power"`
	Territory string `json:"territory"`
	Coast     string `json:"coast,omitempty"`
}

type orderInput struct {
	Type                 string `json:"type"`
	UnitTerritory        string `json:"unitTerritory"`
	UnitCoast            string `json:"unitCoast,omitempty"`
	TargetTerritory      string `json:"targetTerritory,omitempty"`
	TargetCoast          string `json:"targetCoast,omitempty"`
	SupportedUnit        string `json:"supportedUnit,omitempty"`
	SupportedDestination string `json:"supportedDestination,omitempty"`
	ViaConvoy            bool   `json:"viaConvoy,omitempty"`
}

type response struct {
	Validated        bool               `json:"validated,omitempty"`
	Units            []unitOutput       `json:"units"`
	Dislodged        []unitOutput       `json:"dislodged"`
	Resolutions      []resolution       `json:"resolutions"`
	Standoffs        []string           `json:"standoffs"`
	LegalOrders      []legalOrderOutput `json:"legalOrders,omitempty"`
	RetreatContext   *retreatContext    `json:"retreatContext,omitempty"`
	ValidationErrors []string           `json:"validationErrors,omitempty"`
}

type retreatContext struct {
	Dislodgers map[string]string   `json:"dislodgers"`
	Bounces    map[string][]string `json:"bounces"`
}

type unitOutput struct {
	ID             string          `json:"id"`
	Type           string          `json:"type"`
	Power          string          `json:"power"`
	Territory      string          `json:"territory"`
	Coast          string          `json:"coast,omitempty"`
	DislodgedBy    string          `json:"dislodgedBy,omitempty"`
	RetreatOptions []retreatOption `json:"retreatOptions,omitempty"`
}

type retreatOption struct {
	Territory string `json:"territory"`
	Coast     string `json:"coast,omitempty"`
}

type resolution struct {
	Source  string   `json:"source"`
	Type    string   `json:"type"`
	Targets []string `json:"targets"`
	Error   string   `json:"error,omitempty"`
}

type legalOrderOutput struct {
	Type                 string `json:"type"`
	UnitTerritory        string `json:"unitTerritory"`
	UnitCoast            string `json:"unitCoast,omitempty"`
	TargetTerritory      string `json:"targetTerritory,omitempty"`
	TargetCoast          string `json:"targetCoast,omitempty"`
	SupportedUnit        string `json:"supportedUnit,omitempty"`
	SupportedDestination string `json:"supportedDestination,omitempty"`
	ViaConvoy            bool   `json:"viaConvoy,omitempty"`
}

func main() {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fail(fmt.Errorf("decode request: %w", err))
	}
	var output response
	var err error
	if input.Operation == "VALIDATE_BOARD" {
		output.Validated = true
		output.ValidationErrors = validateBoard(input)
	} else if strings.EqualFold(input.Operation, "LEGAL_ORDERS") {
		output, err = legalOrders(input)
	} else {
		output, err = adjudicate(input)
	}
	if err != nil {
		fail(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		fail(fmt.Errorf("encode response: %w", err))
	}
}

func adjudicate(input request) (response, error) {
	state, before, err := loadMovementState(input)
	if err != nil {
		return response{}, err
	}

	for _, submitted := range input.Orders {
		order, err := toGodipOrder(submitted)
		if err != nil {
			return response{}, err
		}
		// An order is filed under the unit's own location, coast included. Godip looks orders up beside
		// units by that exact location; a fleet on a split coast whose order was filed under the bare
		// province was seen as an order with no unit, and a convoying fleet it moved against then
		// crashed the adjudicator.
		if err := state.SetOrder(toGodipLocation(submitted.UnitTerritory, submitted.UnitCoast), order); err != nil {
			return response{}, fmt.Errorf("set order for %s: %w", submitted.UnitTerritory, err)
		}
	}

	if err := state.Next(); err != nil {
		return response{}, fmt.Errorf("adjudicate: %w", err)
	}

	applied := state.PreviouslyAppliedOrders()
	resolutions := state.Resolutions()
	result := response{
		Units:       []unitOutput{},
		Dislodged:   []unitOutput{},
		Resolutions: []resolution{},
		Standoffs:   []string{},
	}

	for source, order := range applied {
		entry := resolution{
			Source: fromGodipProvince(source.Super()),
			Type:   resolutionType(order),
		}
		for _, target := range order.Targets() {
			entry.Targets = append(entry.Targets, fromGodipProvince(target))
		}
		if err := resolutions[source]; err != nil {
			entry.Error = err.Error()
		}
		result.Resolutions = append(result.Resolutions, entry)
	}

	for location, unit := range state.Units() {
		result.Units = append(result.Units, outputUnit(
			unitIDAt(location, before, applied, resolutions),
			location,
			unit,
		))
	}

	_, _, dislodgeds, dislodgers, bounces, _ := state.Dump()
	result.RetreatContext = &retreatContext{Dislodgers: map[string]string{}, Bounces: map[string][]string{}}
	for attacker, victim := range dislodgers {
		result.RetreatContext.Dislodgers[fromGodipProvince(attacker)] = fromGodipProvince(victim)
	}
	for destination, sources := range bounces {
		list := []string{}
		for source := range sources {
			list = append(list, fromGodipProvince(source))
		}
		sort.Strings(list)
		result.RetreatContext.Bounces[fromGodipProvince(destination)] = list
	}
	for location, unit := range dislodgeds {
		output := outputUnit(before[location.Super()].ID, location, unit)
		output.RetreatOptions = retreatOptions(state, location)
		for attacker, victim := range dislodgers {
			if victim.Super() == location.Super() {
				output.DislodgedBy = fromGodipProvince(attacker)
				break
			}
		}
		result.Dislodged = append(result.Dislodged, output)
	}
	for destination := range bounces {
		result.Standoffs = append(result.Standoffs, fromGodipProvince(destination))
	}

	sort.Slice(result.Units, func(i, j int) bool { return result.Units[i].Territory < result.Units[j].Territory })
	sort.Slice(result.Dislodged, func(i, j int) bool { return result.Dislodged[i].Territory < result.Dislodged[j].Territory })
	sort.Slice(result.Resolutions, func(i, j int) bool { return result.Resolutions[i].Source < result.Resolutions[j].Source })
	sort.Strings(result.Standoffs)
	return result, nil
}

func loadMovementState(input request) (*godipstate.State, map[godip.Province]unitInput, error) {
	season := godip.Spring
	if strings.EqualFold(input.Season, "FALL") {
		season = godip.Fall
	}
	state := classical.Blank(classical.NewPhase(input.Year, season, godip.Movement))

	godipUnits := make(map[godip.Province]godip.Unit)
	before := make(map[godip.Province]unitInput)
	for _, unit := range input.Units {
		location := toGodipLocation(unit.Territory, unit.Coast)
		godipUnits[location] = godip.Unit{
			Type:   toGodipUnitType(unit.Type),
			Nation: toGodipNation(unit.Power),
		}
		before[location.Super()] = unit
	}
	if err := state.SetUnits(godipUnits); err != nil {
		return nil, nil, fmt.Errorf("load units: %w", err)
	}

	supplyCenters := make(map[godip.Province]godip.Nation)
	for territory, power := range input.SupplyCenters {
		if power == "" {
			supplyCenters[toGodipProvince(territory)] = godip.Neutral
		} else {
			supplyCenters[toGodipProvince(territory)] = toGodipNation(power)
		}
	}
	state.SetSupplyCenters(supplyCenters)
	return state, before, nil
}

func legalOrders(input request) (response, error) {
	if input.Power == "" {
		return response{}, fmt.Errorf("power is required for LEGAL_ORDERS")
	}
	state, _, err := loadMovementState(input)
	if err != nil {
		return response{}, err
	}
	paths := [][]string{}
	flattenOptions(state.Phase().Options(state, toGodipNation(input.Power)), nil, &paths)
	result := response{LegalOrders: []legalOrderOutput{}}
	for _, path := range paths {
		order, ok := legalOrderFromOptionPath(path)
		if ok {
			result.LegalOrders = append(result.LegalOrders, order)
		}
	}
	sort.Slice(result.LegalOrders, func(i, j int) bool {
		return legalOrderSortKey(result.LegalOrders[i]) < legalOrderSortKey(result.LegalOrders[j])
	})
	return result, nil
}

func flattenOptions(options godip.Options, prefix []string, result *[][]string) {
	if len(options) == 0 {
		*result = append(*result, append([]string{}, prefix...))
		return
	}
	for value, next := range options {
		part := value
		if filtered, ok := value.(godip.FilteredOptionValue); ok {
			part = filtered.Value
		}
		flattenOptions(next, append(prefix, fmt.Sprint(part)), result)
	}
}

func legalOrderFromOptionPath(path []string) (legalOrderOutput, bool) {
	if len(path) < 3 {
		return legalOrderOutput{}, false
	}
	source := godip.Province(path[2])
	output := legalOrderOutput{
		UnitTerritory: fromGodipProvince(source.Super()),
		UnitCoast:     fromGodipCoast(source.Sub()),
	}
	switch godip.OrderType(path[1]) {
	case godip.Hold:
		output.Type = "HOLD"
	case godip.Move, godip.MoveViaConvoy:
		if len(path) != 4 {
			return legalOrderOutput{}, false
		}
		target := godip.Province(path[3])
		output.Type = "MOVE"
		output.TargetTerritory = fromGodipProvince(target.Super())
		output.TargetCoast = fromGodipCoast(target.Sub())
		output.ViaConvoy = godip.OrderType(path[1]) == godip.MoveViaConvoy
	case godip.Support:
		if len(path) != 5 {
			return legalOrderOutput{}, false
		}
		output.SupportedUnit = fromGodipProvince(godip.Province(path[3]).Super())
		destination := fromGodipProvince(godip.Province(path[4]).Super())
		if output.SupportedUnit == destination {
			output.Type = "SUPPORT_HOLD"
		} else {
			output.Type = "SUPPORT_MOVE"
			output.SupportedDestination = destination
		}
	case godip.Convoy:
		if len(path) != 5 {
			return legalOrderOutput{}, false
		}
		output.Type = "CONVOY"
		output.SupportedUnit = fromGodipProvince(godip.Province(path[3]).Super())
		output.TargetTerritory = fromGodipProvince(godip.Province(path[4]).Super())
	default:
		return legalOrderOutput{}, false
	}
	return output, true
}

func legalOrderSortKey(order legalOrderOutput) string {
	return strings.Join([]string{
		order.UnitTerritory,
		order.UnitCoast,
		order.Type,
		order.TargetTerritory,
		order.TargetCoast,
		order.SupportedUnit,
		order.SupportedDestination,
		fmt.Sprint(order.ViaConvoy),
	}, "|")
}

func toGodipOrder(input orderInput) (godip.Adjudicator, error) {
	source := toGodipLocation(input.UnitTerritory, input.UnitCoast)
	switch input.Type {
	case "HOLD":
		return orders.Hold(source), nil
	case "MOVE":
		move := orders.Move(source, toGodipLocation(input.TargetTerritory, input.TargetCoast))
		if input.ViaConvoy {
			move.ViaConvoy()
		}
		return move, nil
	case "SUPPORT_HOLD":
		return orders.SupportHold(source, toGodipProvince(input.SupportedUnit)), nil
	case "SUPPORT_MOVE":
		return orders.SupportMove(
			source,
			toGodipProvince(input.SupportedUnit),
			toGodipProvince(input.SupportedDestination),
		), nil
	case "CONVOY":
		return orders.Convoy(
			source,
			toGodipProvince(input.SupportedUnit),
			toGodipProvince(input.TargetTerritory),
		), nil
	default:
		return nil, fmt.Errorf("unsupported order type %q", input.Type)
	}
}

func unitIDAt(
	location godip.Province,
	before map[godip.Province]unitInput,
	applied map[godip.Province]godip.Adjudicator,
	resolutions map[godip.Province]error,
) string {
	for source, order := range applied {
		targets := order.Targets()
		if order.Type() == godip.Move && len(targets) == 2 &&
			targets[1].Super() == location.Super() && resolutions[source] == nil {
			return before[targets[0].Super()].ID
		}
	}
	return before[location.Super()].ID
}

func retreatOptions(state godip.Validator, source godip.Province) []retreatOption {
	seen := make(map[string]bool)
	var result []retreatOption
	for _, province := range state.Graph().Provinces() {
		for _, destination := range state.Graph().Coasts(province) {
			move := orders.Move(source, destination)
			if _, err := move.Validate(state); err != nil {
				continue
			}
			// Validate may resolve an unqualified split-coast target to its
			// reachable coast. Export that canonical target, not the alias
			// from the graph iteration, so a saved board round-trips exactly.
			canonical := move.Targets()[1]
			territory := fromGodipProvince(canonical)
			coast := fromGodipCoast(canonical.Sub())
			key := territory + "/" + coast
			if !seen[key] {
				seen[key] = true
				result = append(result, retreatOption{
					Territory: territory,
					Coast:     coast,
				})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Territory == result[j].Territory {
			return result[i].Coast < result[j].Coast
		}
		return result[i].Territory < result[j].Territory
	})
	return result
}

func outputUnit(id string, location godip.Province, unit godip.Unit) unitOutput {
	super, sub := location.Split()
	return unitOutput{
		ID:        id,
		Type:      strings.ToUpper(string(unit.Type)),
		Power:     strings.ToUpper(string(unit.Nation)),
		Territory: fromGodipProvince(super),
		Coast:     fromGodipCoast(sub),
	}
}

func resolutionType(order godip.Adjudicator) string {
	if order.Type() == godip.Support {
		if len(order.Targets()) == 2 {
			return "SUPPORT_HOLD"
		}
		return "SUPPORT_MOVE"
	}
	return strings.ToUpper(string(order.Type()))
}

func toGodipProvince(territory string) godip.Province {
	aliases := map[string]string{
		"MAO": "mid",
		"NAO": "nat",
		"NOR": "nwy",
		"NWG": "nrg",
	}
	if alias, ok := aliases[strings.ToUpper(territory)]; ok {
		return godip.Province(alias)
	}
	return godip.Province(strings.ToLower(territory))
}

func toGodipLocation(territory, coast string) godip.Province {
	province := toGodipProvince(territory)
	if coast == "" {
		return province
	}
	return province.Join(godip.Province(toGodipCoast(coast)))
}

func fromGodipProvince(province godip.Province) string {
	aliases := map[string]string{
		"mid": "MAO",
		"nat": "NAO",
		"nrg": "NWG",
		"nwy": "NOR",
	}
	super := province.Super()
	if alias, ok := aliases[string(super)]; ok {
		return alias
	}
	return strings.ToUpper(string(super))
}

func toGodipCoast(coast string) string {
	return map[string]string{
		"NORTH": "nc",
		"SOUTH": "sc",
		"EAST":  "ec",
		"WEST":  "wc",
	}[strings.ToUpper(coast)]
}

func fromGodipCoast(coast godip.Province) string {
	return map[string]string{
		"nc": "NORTH",
		"sc": "SOUTH",
		"ec": "EAST",
		"wc": "WEST",
	}[string(coast)]
}

func toGodipUnitType(unitType string) godip.UnitType {
	if strings.EqualFold(unitType, "FLEET") {
		return godip.Fleet
	}
	return godip.Army
}

func toGodipNation(power string) godip.Nation {
	return map[string]godip.Nation{
		"AUSTRIA": godip.Austria,
		"ENGLAND": godip.England,
		"FRANCE":  godip.France,
		"GERMANY": godip.Germany,
		"ITALY":   godip.Italy,
		"RUSSIA":  godip.Russia,
		"TURKEY":  godip.Turkey,
	}[strings.ToUpper(power)]
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
