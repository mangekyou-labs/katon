package matcher

// This file is the small, dependency-free implementation of the Weather FCC
// envelope. The wire format is ABI encoded and each recipient ciphertext is
// secp256k1 ECIES (compressed ephemeral key || nonce || AES-GCM ciphertext).

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"regexp"
	"strings"

	"golang.org/x/crypto/hkdf"
)

const maxFccEnvelopeBytes = 256 * 1024

var fccHex32 = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

type FccEnvelopeMetadata struct {
	ChainID                                uint64
	ExtensionID, ActionID, OPType, Command string
	Expiry                                 uint64
}
type FccRecipient struct{ TEEID, KeyID, Ciphertext string }
type FccRecipientEnvelopeV1 struct {
	Version                                uint8
	ChainID                                uint64
	ExtensionID, ActionID, OPType, Command string
	Expiry                                 uint64
	PlaintextCommitment                    string
	Recipients                             [3]FccRecipient
	Encoded                                []byte
}
type FccEncryptionRecipient struct {
	TEEID, KeyID string
	PublicKey    []byte
}

// PublicKeyFromPrivate derives a compressed secp256k1 public key for test and
// local rehearsal fixtures. Production encryption receives public keys from
// verified FCC proxy /info responses; private keys stay with the TEE node.
func PublicKeyFromPrivate(privateKey []byte) ([]byte, error) {
	scalar, err := scalarFromBytes(privateKey)
	if err != nil {
		return nil, err
	}
	return compressedPoint(scalarMult(basePoint, scalar)), nil
}

func EncryptFccEnvelope(plaintext []byte, metadata FccEnvelopeMetadata, recipients []FccEncryptionRecipient, nonces [][]byte) (FccRecipientEnvelopeV1, error) {
	if err := validateFccMetadata(metadata); err != nil {
		return FccRecipientEnvelopeV1{}, err
	}
	if len(plaintext) > maxFccEnvelopeBytes {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_SIZE")
	}
	if len(recipients) != 3 {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_RECIPIENT_COUNT")
	}
	if len(nonces) != 0 && len(nonces) != 3 {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_NONCE")
	}
	commitment := keccakHex(plaintext)
	envelope := FccRecipientEnvelopeV1{Version: 1, ChainID: metadata.ChainID, ExtensionID: metadata.ExtensionID, ActionID: metadata.ActionID, OPType: normalizeIdentifier(metadata.OPType), Command: normalizeIdentifier(metadata.Command), Expiry: metadata.Expiry, PlaintextCommitment: commitment}
	aad := fccEnvelopeAssociatedData(envelope)
	seenTee, seenKey := map[string]bool{}, map[string]bool{}
	for i, recipient := range recipients {
		teeID, err := identityBytes32(recipient.TEEID)
		if err != nil {
			return FccRecipientEnvelopeV1{}, err
		}
		keyID, err := identityBytes32(recipient.KeyID)
		if err != nil {
			return FccRecipientEnvelopeV1{}, err
		}
		if seenTee[teeID] || seenKey[keyID] {
			return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_DUPLICATE")
		}
		seenTee[teeID], seenKey[keyID] = true, true
		pub, err := parsePublicKey(recipient.PublicKey)
		if err != nil {
			return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_KEY")
		}
		ephemeral, err := randomScalar()
		if err != nil {
			return FccRecipientEnvelopeV1{}, err
		}
		if len(nonces) == 3 {
			if len(nonces[i]) != 12 {
				return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_NONCE")
			}
			ephemeral.Nonce = append([]byte(nil), nonces[i]...)
		} else {
			ephemeral.Nonce = make([]byte, 12)
			if _, err := io.ReadFull(rand.Reader, ephemeral.Nonce); err != nil {
				return FccRecipientEnvelopeV1{}, err
			}
		}
		shared, err := ecdh(pub, ephemeral.Scalar)
		if err != nil {
			return FccRecipientEnvelopeV1{}, err
		}
		key := hkdfKey(shared)
		sealed, err := seal(plaintext, key, ephemeral.Nonce, aad)
		if err != nil {
			return FccRecipientEnvelopeV1{}, err
		}
		packed := append(compressedPoint(ephemeral.Point), ephemeral.Nonce...)
		packed = append(packed, sealed...)
		envelope.Recipients[i] = FccRecipient{TEEID: teeID, KeyID: keyID, Ciphertext: "0x" + hex.EncodeToString(packed)}
	}
	envelope.Encoded, _ = EncodeFccRecipientEnvelope(envelope)
	return envelope, nil
}

func EncodeFccRecipientEnvelope(envelope FccRecipientEnvelopeV1) ([]byte, error) {
	if err := validateFccEnvelope(envelope); err != nil {
		return nil, err
	}
	words := make([][]byte, 0, 15)
	words = append(words, wordUint(uint64(envelope.Version)), wordUint(envelope.ChainID), wordHex(envelope.ExtensionID), wordHex(envelope.ActionID), wordIdentifier(envelope.OPType), wordIdentifier(envelope.Command), wordUint(envelope.Expiry), wordHex(envelope.PlaintextCommitment))
	for _, recipient := range envelope.Recipients {
		words = append(words, wordHex(recipient.TEEID))
	}
	for _, recipient := range envelope.Recipients {
		words = append(words, wordHex(recipient.KeyID))
	}
	// bytes[3] is the final dynamic parameter. Its offset is measured from the
	// beginning of the ABI tuple; the array itself has no length word.
	words = append(words, wordUint(uint64(len(words)+1)*32))
	head := bytes.Join(words, nil)
	arrayHead := make([]byte, 0, 96)
	tails := make([][]byte, 0, 3)
	offset := uint64(3 * 32)
	for _, recipient := range envelope.Recipients {
		data, _ := hex.DecodeString(strings.TrimPrefix(recipient.Ciphertext, "0x"))
		tail := append(wordUint(uint64(len(data))), data...)
		tail = pad32(tail)
		arrayHead = append(arrayHead, wordUint(offset)...)
		tails = append(tails, tail)
		offset += uint64(len(tail))
	}
	for _, tail := range tails {
		arrayHead = append(arrayHead, tail...)
	}
	return append(head, arrayHead...), nil
}

func ParseFccEnvelope(data []byte) (FccRecipientEnvelopeV1, error) {
	return ParseFccRecipientEnvelope(data)
}
func ParseFccRecipientEnvelope(data []byte) (FccRecipientEnvelopeV1, error) {
	if len(data) > maxFccEnvelopeBytes || len(data) < 15*32 {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_ABI")
	}
	word := func(i int) []byte { return data[i*32 : (i+1)*32] }
	envelope := FccRecipientEnvelopeV1{Version: uint8(new(big.Int).SetBytes(word(0)).Uint64()), ChainID: new(big.Int).SetBytes(word(1)).Uint64(), ExtensionID: "0x" + hex.EncodeToString(word(2)), ActionID: "0x" + hex.EncodeToString(word(3)), OPType: decodeBytes32(word(4)), Command: decodeBytes32(word(5)), Expiry: new(big.Int).SetBytes(word(6)).Uint64(), PlaintextCommitment: "0x" + hex.EncodeToString(word(7))}
	for i := 0; i < 3; i++ {
		envelope.Recipients[i].TEEID = "0x" + hex.EncodeToString(word(8+i))
		envelope.Recipients[i].KeyID = "0x" + hex.EncodeToString(word(11+i))
	}
	arrayOffset := new(big.Int).SetBytes(word(14)).Uint64()
	if arrayOffset%32 != 0 || arrayOffset+3*32 > uint64(len(data)) {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_ABI")
	}
	for i := 0; i < 3; i++ {
		rel := new(big.Int).SetBytes(data[arrayOffset+uint64(i*32) : arrayOffset+uint64((i+1)*32)]).Uint64()
		start := arrayOffset + rel
		if start+32 > uint64(len(data)) {
			return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_ABI")
		}
		n := new(big.Int).SetBytes(data[start : start+32]).Uint64()
		if start+32+n > uint64(len(data)) {
			return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_ABI")
		}
		envelope.Recipients[i].Ciphertext = "0x" + hex.EncodeToString(data[start+32:start+32+n])
	}
	if err := validateFccEnvelope(envelope); err != nil {
		return FccRecipientEnvelopeV1{}, err
	}
	canonical, err := EncodeFccRecipientEnvelope(envelope)
	if err != nil || !bytes.Equal(canonical, data) {
		return FccRecipientEnvelopeV1{}, errors.New("FCC_ENVELOPE_CANONICAL")
	}
	envelope.Encoded = append([]byte(nil), data...)
	return envelope, nil
}

func CanonicalFccEnvelope(envelope FccRecipientEnvelopeV1) ([]byte, error) {
	return EncodeFccRecipientEnvelope(envelope)
}

func DecryptFccRecipient(envelope FccRecipientEnvelopeV1, teeID string, privateKey []byte, now uint64) ([]byte, error) {
	if err := validateFccEnvelope(envelope); err != nil {
		return nil, err
	}
	if envelope.Expiry < now {
		return nil, errors.New("FCC_ENVELOPE_EXPIRED")
	}
	id, err := identityBytes32(teeID)
	if err != nil {
		return nil, err
	}
	var recipient *FccRecipient
	for i := range envelope.Recipients {
		if strings.EqualFold(envelope.Recipients[i].TEEID, id) {
			recipient = &envelope.Recipients[i]
			break
		}
	}
	if recipient == nil {
		return nil, errors.New("FCC_ENVELOPE_RECIPIENT")
	}
	packed, err := hex.DecodeString(strings.TrimPrefix(recipient.Ciphertext, "0x"))
	if err != nil || len(packed) < 61 {
		return nil, errors.New("FCC_ENVELOPE_CIPHERTEXT")
	}
	priv, err := scalarFromBytes(privateKey)
	if err != nil {
		return nil, errors.New("FCC_ENVELOPE_KEY")
	}
	pub, err := parsePublicKey(packed[:33])
	if err != nil {
		return nil, errors.New("FCC_ENVELOPE_AUTH_FAILED")
	}
	shared, err := ecdh(pub, priv)
	if err != nil {
		return nil, errors.New("FCC_ENVELOPE_AUTH_FAILED")
	}
	plaintext, err := open(packed[45:], hkdfKey(shared), packed[33:45], fccEnvelopeAssociatedData(envelope))
	if err != nil {
		return nil, errors.New("FCC_ENVELOPE_AUTH_FAILED")
	}
	if !strings.EqualFold(keccakHex(plaintext), envelope.PlaintextCommitment) {
		return nil, errors.New("FCC_ENVELOPE_COMMITMENT")
	}
	return plaintext, nil
}

func validateFccEnvelope(envelope FccRecipientEnvelopeV1) error {
	if envelope.Version != 1 {
		return errors.New("FCC_ENVELOPE_VERSION")
	}
	if err := validateFccMetadata(FccEnvelopeMetadata{ChainID: envelope.ChainID, ExtensionID: envelope.ExtensionID, ActionID: envelope.ActionID, OPType: envelope.OPType, Command: envelope.Command, Expiry: envelope.Expiry}); err != nil {
		return err
	}
	if !fccHex32.MatchString(envelope.PlaintextCommitment) {
		return errors.New("FCC_ENVELOPE_COMMITMENT")
	}
	seenTee, seenKey := map[string]bool{}, map[string]bool{}
	for _, recipient := range envelope.Recipients {
		if !fccHex32.MatchString(recipient.TEEID) || !fccHex32.MatchString(recipient.KeyID) || !strings.HasPrefix(recipient.Ciphertext, "0x") {
			return errors.New("FCC_ENVELOPE_RECIPIENT")
		}
		if seenTee[recipient.TEEID] || seenKey[recipient.KeyID] {
			return errors.New("FCC_ENVELOPE_DUPLICATE")
		}
		seenTee[recipient.TEEID], seenKey[recipient.KeyID] = true, true
	}
	return nil
}
func validateFccMetadata(metadata FccEnvelopeMetadata) error {
	if !fccHex32.MatchString(metadata.ExtensionID) || !fccHex32.MatchString(metadata.ActionID) {
		return errors.New("FCC_ENVELOPE_ID")
	}
	if metadata.OPType == "" || len(metadata.OPType) > 32 {
		return errors.New("FCC_ENVELOPE_OP_TYPE")
	}
	if metadata.Command == "" || len(metadata.Command) > 32 {
		return errors.New("FCC_ENVELOPE_COMMAND")
	}
	if metadata.Expiry == 0 {
		return errors.New("FCC_ENVELOPE_EXPIRY")
	}
	return nil
}
func identityBytes32(value string) (string, error) {
	if fccHex32.MatchString(value) {
		return strings.ToLower(value), nil
	}
	if value == "" || len(value) > 32 {
		return "", errors.New("FCC_ENVELOPE_RECIPIENT")
	}
	return "0x" + hex.EncodeToString(append([]byte(value), make([]byte, 32-len(value))...)), nil
}
func decodeBytes32(value []byte) string { return strings.TrimRight(string(value), "\x00") }
func normalizeIdentifier(value string) string {
	if fccHex32.MatchString(value) {
		b, _ := hex.DecodeString(strings.TrimPrefix(value, "0x"))
		return decodeBytes32(b)
	}
	return value
}
func wordUint(value uint64) []byte { return wordBig(new(big.Int).SetUint64(value)) }
func wordHex(value string) []byte {
	b, _ := hex.DecodeString(strings.TrimPrefix(value, "0x"))
	return append(make([]byte, 32-len(b)), b...)
}
func wordIdentifier(value string) []byte { return wordHex(bytes32Identifier(value)) }
func wordBig(value *big.Int) []byte {
	return append(make([]byte, 32-len(value.Bytes())), value.Bytes()...)
}
func pad32(value []byte) []byte {
	if rem := len(value) % 32; rem != 0 {
		value = append(value, make([]byte, 32-rem)...)
	}
	return value
}

type scalarPoint struct {
	Scalar *big.Int
	Point  *point
	Nonce  []byte
}

func randomScalar() (*scalarPoint, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return nil, err
	}
	s, err := scalarFromBytes(b)
	if err != nil {
		return nil, err
	}
	return &scalarPoint{Scalar: s, Point: scalarMult(basePoint, s)}, nil
}

var secpP, _ = new(big.Int).SetString("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16)
var secpN, _ = new(big.Int).SetString("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)
var basePoint = &point{x: mustBig("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"), y: mustBig("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8")}

type point struct{ x, y *big.Int }

func mustBig(value string) *big.Int { v, _ := new(big.Int).SetString(value, 16); return v }
func scalarFromBytes(value []byte) (*big.Int, error) {
	if len(value) != 32 {
		return nil, errors.New("scalar")
	}
	s := new(big.Int).SetBytes(value)
	if s.Sign() == 0 || s.Cmp(secpN) >= 0 {
		return nil, errors.New("scalar")
	}
	return s, nil
}
func pointAdd(a, b *point) *point {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	if a.x.Cmp(b.x) == 0 {
		if a.y.Cmp(b.y) == 0 {
			three := new(big.Int).Mul(a.x, a.x)
			three.Mul(three, big.NewInt(3))
			den := new(big.Int).Mul(a.y, big.NewInt(2))
			den.ModInverse(den, secpP)
			lam := new(big.Int).Mul(three, den)
			lam.Mod(lam, secpP)
			x := new(big.Int).Mul(lam, lam)
			x.Sub(x, new(big.Int).Lsh(a.x, 1))
			x.Mod(x, secpP)
			y := new(big.Int).Sub(a.x, x)
			y.Mul(lam, y)
			y.Sub(y, a.y)
			y.Mod(y, secpP)
			return &point{x, y}
		}
		return nil
	}
	num := new(big.Int).Sub(b.y, a.y)
	den := new(big.Int).Sub(b.x, a.x)
	den.ModInverse(den, secpP)
	lam := new(big.Int).Mul(num, den)
	lam.Mod(lam, secpP)
	x := new(big.Int).Mul(lam, lam)
	x.Sub(x, a.x)
	x.Sub(x, b.x)
	x.Mod(x, secpP)
	y := new(big.Int).Sub(a.x, x)
	y.Mul(lam, y)
	y.Sub(y, a.y)
	y.Mod(y, secpP)
	return &point{x, y}
}
func scalarMult(p *point, scalar *big.Int) *point {
	var out *point
	for i := scalar.BitLen() - 1; i >= 0; i-- {
		out = pointAdd(out, out)
		if scalar.Bit(i) == 1 {
			out = pointAdd(out, p)
		}
	}
	return out
}
func compressedPoint(p *point) []byte {
	out := []byte{0x02}
	if p.y.Bit(0) == 1 {
		out[0] = 0x03
	}
	out = append(out, wordBig(p.x)...)
	return out
}
func parsePublicKey(value []byte) (*point, error) {
	if len(value) == 66 && value[0] == '0' && value[1] == 'x' {
		var err error
		value, err = hex.DecodeString(string(value[2:]))
		if err != nil {
			return nil, err
		}
	}
	if len(value) == 33 && (value[0] == 2 || value[0] == 3) {
		x := new(big.Int).SetBytes(value[1:])
		if x.Cmp(secpP) >= 0 {
			return nil, errors.New("point")
		}
		y2 := new(big.Int).Mul(x, x)
		y2.Mul(y2, x)
		y2.Add(y2, big.NewInt(7))
		y2.Mod(y2, secpP)
		y := new(big.Int).Exp(y2, new(big.Int).Div(new(big.Int).Add(secpP, big.NewInt(1)), big.NewInt(4)), secpP)
		if y.Bit(0) != uint(value[0]-2) {
			y.Sub(secpP, y)
		}
		return &point{x, y}, nil
	}
	if len(value) == 65 && value[0] == 4 {
		return &point{new(big.Int).SetBytes(value[1:33]), new(big.Int).SetBytes(value[33:])}, nil
	}
	return nil, errors.New("point")
}
func ecdh(pub *point, priv *big.Int) ([]byte, error) {
	shared := scalarMult(pub, priv)
	if shared == nil {
		return nil, errors.New("ecdh")
	}
	return wordBig(shared.x), nil
}
func hkdfKey(shared []byte) []byte {
	key := make([]byte, 32)
	reader := hkdf.New(sha256.New, shared, nil, []byte("FCC-ECIES-v1"))
	_, _ = io.ReadFull(reader, key)
	return key
}
func seal(plaintext, key, nonce, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nonce, plaintext, aad), nil
}
func open(ciphertext, key, nonce, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func fccEnvelopeAssociatedData(envelope FccRecipientEnvelopeV1) []byte {
	return bytes.Join([][]byte{wordUint(1), wordUint(envelope.ChainID), wordHex(envelope.ExtensionID), wordHex(envelope.ActionID), wordIdentifier(envelope.OPType), wordIdentifier(envelope.Command), wordUint(envelope.Expiry), wordHex(envelope.PlaintextCommitment)}, nil)
}
