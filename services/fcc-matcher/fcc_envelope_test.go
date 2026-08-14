package matcher

import "testing"

func TestFccEnvelopeMatchesCanonicalWire(t *testing.T) {

	metadata := FccEnvelopeMetadata{
		ChainID:     114,
		ExtensionID: "0x1111111111111111111111111111111111111111111111111111111111111111",
		ActionID:    "0x2222222222222222222222222222222222222222222222222222222222222222",
		OPType:      "RFQ",
		Command:     "CREATE",
		Expiry:      1800000000,
	}
	recipients := []FccEncryptionRecipient{
		{TEEID: "tee-a", KeyID: "key-a", PublicKey: mustPublicKey(t, bytesFilled(1))},
		{TEEID: "tee-b", KeyID: "key-b", PublicKey: mustPublicKey(t, bytesFilled(2))},
		{TEEID: "tee-c", KeyID: "key-c", PublicKey: mustPublicKey(t, bytesFilled(3))},
	}
	nonces := [][]byte{bytesFilledN(10, 12), bytesFilledN(11, 12), bytesFilledN(12, 12)}
	envelope, err := EncryptFccEnvelope([]byte(`{"route":"secret"}`), metadata, recipients, nonces)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalFccEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("canonical=%s", canonical)
	parsed, err := ParseFccEnvelope(canonical)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := DecryptFccRecipient(parsed, "tee-b", bytesFilled(2), 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != `{"route":"secret"}` {
		t.Fatalf("plaintext = %q", plaintext)
	}
}

func mustPublicKey(t *testing.T, privateKey []byte) []byte {
	t.Helper()
	publicKey, err := PublicKeyFromPrivate(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return publicKey
}

func TestFccEnvelopeRejectsNonCanonicalAndDuplicates(t *testing.T) {
	if _, err := ParseFccEnvelope([]byte(`{"version":1}`)); err == nil {
		t.Fatal("expected malformed envelope error")
	}
}

func TestFccEnvelopeAuthenticatesOuterMetadata(t *testing.T) {
	metadata := FccEnvelopeMetadata{ChainID: 114, ExtensionID: "0x1111111111111111111111111111111111111111111111111111111111111111", ActionID: "0x2222222222222222222222222222222222222222222222222222222222222222", OPType: "RFQ", Command: "CREATE", Expiry: 1800000000}
	recipients := []FccEncryptionRecipient{
		{TEEID: "tee-a", KeyID: "key-a", PublicKey: mustPublicKey(t, bytesFilled(1))},
		{TEEID: "tee-b", KeyID: "key-b", PublicKey: mustPublicKey(t, bytesFilled(2))},
		{TEEID: "tee-c", KeyID: "key-c", PublicKey: mustPublicKey(t, bytesFilled(3))},
	}
	envelope, err := EncryptFccEnvelope([]byte(`{"side":"sell"}`), metadata, recipients, [][]byte{bytesFilledN(30, 12), bytesFilledN(31, 12), bytesFilledN(32, 12)})
	if err != nil { t.Fatal(err) }
	envelope.ActionID = "0x3333333333333333333333333333333333333333333333333333333333333333"
	if _, err := DecryptFccRecipient(envelope, "tee-a", bytesFilled(1), 1700000000); err == nil || err.Error() != "FCC_ENVELOPE_AUTH_FAILED" {
		t.Fatalf("expected authenticated metadata rejection, got %v", err)
	}
}

func bytesFilled(value byte) []byte { return bytesFilledN(value, 32) }

func bytesFilledN(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}
