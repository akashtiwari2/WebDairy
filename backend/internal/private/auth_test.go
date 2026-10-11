package private

import (
	"encoding/base64"
	"encoding/hex"
	"golang.org/x/crypto/argon2"
	"strings"
	"testing"
)

func TestPasswordHash(t *testing.T) {
	hash, err := PasswordHash("synthetic login password")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("synthetic login password", hash) || VerifyPassword("wrong password", hash) {
		t.Fatal("password verification")
	}
	next, _ := PasswordHash("synthetic login password")
	if next == hash {
		t.Fatal("salt reused")
	}
	if VerifyPassword("synthetic login password", strings.Replace(hash, "m=65536", "m=999999999", 1)) {
		t.Fatal("unsafe KDF accepted")
	}
	if _, err = PasswordHash("short"); err == nil {
		t.Fatal("short password accepted")
	}
}
func TestEnvelopeAndCiphertextLimits(t *testing.T) {
	b64 := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
	e := Envelope{FormatVersion: 1, VaultID: "12345678-1234-4234-8234-123456789012", Passphrase: PasswordEnvelope{KDF: KDF{Algorithm: "argon2id", Version: 19, Memory: 65536, Iterations: 3, Parallelism: 1, Salt: b64(16)}, Nonce: b64(12), Ciphertext: b64(48)}, Recovery: RecoveryEnvelope{Algorithm: "HKDF-SHA256", Salt: b64(16), Nonce: b64(12), Ciphertext: b64(48)}}
	if !ValidEnvelope(e) {
		t.Fatal("valid format rejected")
	}
	e.Passphrase.KDF.Memory = 999999999
	if ValidEnvelope(e) {
		t.Fatal("hostile KDF accepted")
	}
	w := Write{Epoch: "12345678-1234-4234-8234-123456789012", CryptoVersion: 1, Nonce: b64(12), Ciphertext: b64(16), OperationID: "12345678-1234-4234-8234-123456789012"}
	if !ValidWrite(w) {
		t.Fatal("valid write rejected")
	}
	w.Nonce = b64(11)
	if ValidWrite(w) {
		t.Fatal("bad nonce accepted")
	}
	w.Nonce = b64(12)
	w.Ciphertext = b64(1500001)
	if ValidWrite(w) {
		t.Fatal("oversize accepted")
	}
}

// This fixture is independently asserted by the browser hash-wasm tests.
func TestArgon2VaultFixture(t *testing.T) {
	salt := make([]byte, 16)
	for i := range salt {
		salt[i] = byte(i)
	}
	digest := argon2.IDKey([]byte("synthetic Argon2 fixture"), salt, 3, 65536, 1, 32)
	if hex.EncodeToString(digest) != "de00760260e1439f9a348a6b68f4b4ab4d999690f770a183ebd26df8e23d7333" {
		t.Fatal("Argon2 fixture mismatch")
	}
}
