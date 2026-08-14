package matcher

import (
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
)

// SwapRouteLeg is the off-chain form of RFQRouter.Leg.
type SwapRouteLeg struct {
	Source     string `json:"source"`
	SellAmount string `json:"sellAmount"`
	MinOutput  string `json:"minOutput"`
	SourceData string `json:"sourceData"`
}

// SwapRoutePlan is the off-chain form of RFQRouter.SwapRoutePlan.
type SwapRoutePlan struct {
	ChainID                    uint64         `json:"chainId"`
	Router                     string         `json:"router"`
	Commitment                 string         `json:"commitment"`
	FccActionID                string         `json:"fccActionId"`
	DecisionBlock              string         `json:"decisionBlock"`
	DecisionBlockHash          string         `json:"decisionBlockHash"`
	Deadline                   string         `json:"deadline"`
	Seller                     string         `json:"seller"`
	Recipient                  string         `json:"recipient"`
	SellToken                  string         `json:"sellToken"`
	BuyToken                   string         `json:"buyToken"`
	SellAmount                 string         `json:"sellAmount"`
	MinOutput                  string         `json:"minOutput"`
	ProtocolFeeBps             uint16         `json:"protocolFeeBps"`
	EligibilityPolicyID        string         `json:"eligibilityPolicyId"`
	EligibilityRevocationEpoch string         `json:"eligibilityRevocationEpoch"`
	EligibilityRole            string         `json:"eligibilityRole"`
	EligibilityIssuerReference string         `json:"eligibilityIssuerReference"`
	Legs                       []SwapRouteLeg `json:"legs"`
}

// HashSwapRoute returns keccak256(abi.encode(route)), matching RFQRouter.hashSwapRoute.
func HashSwapRoute(route SwapRoutePlan) (string, error) {
	if len(route.Legs) == 0 {
		return "", errors.New("ROUTE_LEGS")
	}
	encoded, err := encodeSwapRoute(route)
	if err != nil {
		return "", err
	}
	return keccakHex(encoded), nil
}

func encodeSwapRoute(route SwapRoutePlan) ([]byte, error) {
	// abi.encode of a dynamic tuple: offset 0x20 then tuple head+tail.
	tuple, err := encodeSwapRouteTuple(route)
	if err != nil {
		return nil, err
	}
	return append(uintWord(big.NewInt(32)), tuple...), nil
}

func encodeSwapRouteTuple(route SwapRoutePlan) ([]byte, error) {
	legsPayload, err := encodeLegs(route.Legs)
	if err != nil {
		return nil, err
	}
	const headWords = 19
	head := make([]byte, 0, headWords*32)
	words := [][]byte{
		uintWord(new(big.Int).SetUint64(route.ChainID)),
		addressWord(route.Router),
		bytes32Word(route.Commitment),
		bytes32Word(route.FccActionID),
		decimalWord(route.DecisionBlock),
		bytes32Word(route.DecisionBlockHash),
		decimalWord(route.Deadline),
		addressWord(route.Seller),
		addressWord(route.Recipient),
		addressWord(route.SellToken),
		addressWord(route.BuyToken),
		decimalWord(route.SellAmount),
		decimalWord(route.MinOutput),
		uintWord(new(big.Int).SetUint64(uint64(route.ProtocolFeeBps))),
		bytes32Word(route.EligibilityPolicyID),
		decimalWord(route.EligibilityRevocationEpoch),
		decimalWord(route.EligibilityRole),
		bytes32Word(route.EligibilityIssuerReference),
		uintWord(big.NewInt(int64(headWords * 32))),
	}
	for _, word := range words {
		if word == nil {
			return nil, errors.New("ROUTE_ENCODE")
		}
		head = append(head, word...)
	}
	return append(head, legsPayload...), nil
}

func encodeLegs(legs []SwapRouteLeg) ([]byte, error) {
	// Dynamic array of dynamic tuples.
	// [length][offset0][offset1]...[tuple0][tuple1]...
	offsetsHead := make([]byte, 0, 32+len(legs)*32)
	offsetsHead = append(offsetsHead, uintWord(big.NewInt(int64(len(legs))))...)
	bodies := make([][]byte, 0, len(legs))
	running := len(legs) * 32
	for _, leg := range legs {
		body, err := encodeLegTuple(leg)
		if err != nil {
			return nil, err
		}
		offsetsHead = append(offsetsHead, uintWord(big.NewInt(int64(running)))...)
		bodies = append(bodies, body)
		running += len(body)
	}
	out := offsetsHead
	for _, body := range bodies {
		out = append(out, body...)
	}
	return out, nil
}

func encodeLegTuple(leg SwapRouteLeg) ([]byte, error) {
	data, err := decodeFlexibleHex(leg.SourceData)
	if err != nil {
		return nil, err
	}
	// source, sellAmount, minOutput, offset(0x80), then bytes
	head := make([]byte, 0, 128)
	for _, word := range [][]byte{
		addressWord(leg.Source),
		decimalWord(leg.SellAmount),
		decimalWord(leg.MinOutput),
		uintWord(big.NewInt(128)),
	} {
		if word == nil {
			return nil, errors.New("ROUTE_ENCODE")
		}
		head = append(head, word...)
	}
	return append(head, encodeBytes(data)...), nil
}

func encodeBytes(data []byte) []byte {
	out := append([]byte{}, uintWord(big.NewInt(int64(len(data))))...)
	if len(data) == 0 {
		return out
	}
	padded := make([]byte, ((len(data)+31)/32)*32)
	copy(padded, data)
	return append(out, padded...)
}

func decodeFlexibleHex(value string) ([]byte, error) {
	if value == "" || value == "0x" {
		return []byte{}, nil
	}
	trimmed := strings.TrimPrefix(value, "0x")
	if len(trimmed)%2 == 1 {
		return nil, errors.New("ROUTE_ENCODE")
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil, errors.New("ROUTE_ENCODE")
	}
	return decoded, nil
}
