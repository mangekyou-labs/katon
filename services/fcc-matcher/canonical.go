package matcher

import (
	"encoding/hex"
	"errors"
	"math/big"
	"strings"

	"golang.org/x/crypto/sha3"
)

type CanonicalDomain struct {
	Name              string
	Version           string
	ChainID           uint64
	VerifyingContract string
}

type CanonicalOrder struct {
	Maker              string
	Taker              string
	Executor           string
	SellToken          string
	BuyToken           string
	SellAmount         string
	MinBuyAmount       string
	Expiry             string
	Nonce              string
	PairSalt           string
	ContextCommitment  string
	OrderType          uint8
	FillMode           uint8
	FeeBps             uint16
}

func HashCanonicalOrder(order CanonicalOrder, domain CanonicalDomain) (string, error) {
	const domainType = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
	const orderType = "Order(address maker,address taker,address executor,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint64 expiry,uint256 nonce,bytes32 pairSalt,bytes32 contextCommitment,uint8 orderType,uint8 fillMode,uint16 feeBps)"
	if expiry, ok := new(big.Int).SetString(order.Expiry, 10); ok && (expiry.Sign() < 0 || expiry.BitLen() > 64) {
		return "", errors.New("EXPIRY_WIDTH")
	}

	domainWords, err := joinWords(
		keccak([]byte(domainType)),
		keccak([]byte(domain.Name)),
		keccak([]byte(domain.Version)),
		uintWord(new(big.Int).SetUint64(domain.ChainID)),
		addressWord(domain.VerifyingContract),
	)
	if err != nil {
		return "", err
	}
	domainSeparator := keccak(domainWords)

	orderWords, err := joinWords(
		keccak([]byte(orderType)),
		addressWord(order.Maker),
		addressWord(order.Taker),
		addressWord(order.Executor),
		addressWord(order.SellToken),
		addressWord(order.BuyToken),
		decimalWord(order.SellAmount),
		decimalWord(order.MinBuyAmount),
		decimalWord(order.Expiry),
		decimalWord(order.Nonce),
		bytes32Word(order.PairSalt),
		bytes32Word(order.ContextCommitment),
		uintWord(new(big.Int).SetUint64(uint64(order.OrderType))),
		uintWord(new(big.Int).SetUint64(uint64(order.FillMode))),
		uintWord(new(big.Int).SetUint64(uint64(order.FeeBps))),
	)
	if err != nil {
		return "", err
	}
	structHash := keccak(orderWords)
	digest := keccak(append([]byte{0x19, 0x01}, append(domainSeparator, structHash...)...))
	return "0x" + hex.EncodeToString(digest), nil
}

func joinWords(words ...[]byte) ([]byte, error) {
	result := make([]byte, 0, len(words)*32)
	for _, word := range words {
		if len(word) != 32 {
			return nil, errors.New("CANONICAL_WORD")
		}
		result = append(result, word...)
	}
	return result, nil
}

func decimalWord(value string) []byte {
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.Sign() < 0 {
		return nil
	}
	return uintWord(parsed)
}

func uintWord(value *big.Int) []byte {
	if value == nil || value.Sign() < 0 || len(value.Bytes()) > 32 {
		return nil
	}
	word := make([]byte, 32)
	copy(word[32-len(value.Bytes()):], value.Bytes())
	return word
}

func addressWord(value string) []byte {
	decoded := decodeHex(value, 20)
	if decoded == nil {
		return nil
	}
	word := make([]byte, 32)
	copy(word[12:], decoded)
	return word
}

func bytes32Word(value string) []byte {
	return decodeHex(value, 32)
}

func decodeHex(value string, size int) []byte {
	trimmed := strings.TrimPrefix(value, "0x")
	if len(trimmed) != size*2 {
		return nil
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil
	}
	return decoded
}

func keccak(value []byte) []byte {
	hash := sha3.NewLegacyKeccak256()
	_, _ = hash.Write(value)
	return hash.Sum(nil)
}
