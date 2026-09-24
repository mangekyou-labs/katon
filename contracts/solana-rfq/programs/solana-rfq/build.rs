use std::{env, fs, path::PathBuf};

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const LOCAL_VAULT: &str = "6gBq2J7rg3x2ic1de6QBSXq5WLfuaLfswGz7tvmKkz6P";
// Read-only `solana program show` on Devnet returned this as the deployed
// program's upgrade authority. The deployment handoff identifies it as the
// existing Squads vault; do not replace it with the local test fixture.
const VERIFIED_DEVNET_VAULT: Option<&str> = Some("8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf");

fn decode_pubkey(value: &str) -> Result<[u8; 32], String> {
    let mut bytes = vec![0u8];
    for character in value.bytes() {
        let digit = ALPHABET
            .iter()
            .position(|candidate| *candidate == character)
            .ok_or_else(|| "vault authority must be base58".to_owned())? as u32;
        let mut carry = digit;
        for byte in bytes.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let leading_zeroes = value
        .bytes()
        .take_while(|character| *character == b'1')
        .count();
    if bytes.len() == 1 && bytes[0] == 0 {
        bytes.clear();
    }
    let mut decoded = vec![0u8; leading_zeroes];
    decoded.extend(bytes);
    if decoded.len() != 32 {
        return Err("vault authority must decode to 32 bytes".to_owned());
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&decoded);
    Ok(result)
}

fn main() {
    println!("cargo:rerun-if-env-changed=SOLANA_SQUADS_VAULT_AUTHORITY");
    println!("cargo:rerun-if-env-changed=KATON_DEPLOYMENT_BUILD");
    println!("cargo:rerun-if-env-changed=KATON_VERIFIED_DEVNET_SQUADS_VAULT_AUTHORITY");
    let configured =
        env::var("SOLANA_SQUADS_VAULT_AUTHORITY").unwrap_or_else(|_| LOCAL_VAULT.to_owned());
    let deployment =
        env::var("KATON_DEPLOYMENT_BUILD").is_ok_and(|value| value == "1" || value == "true");
    if deployment {
        let verified = VERIFIED_DEVNET_VAULT.unwrap_or_else(|| {
            panic!("deployment build rejected: Devnet Squads vault identity is not verified and pinned in build.rs")
        });
        let supplied = env::var("KATON_VERIFIED_DEVNET_SQUADS_VAULT_AUTHORITY")
            .unwrap_or_else(|_| panic!("deployment build rejected: provide the separately pinned Devnet vault identity"));
        if supplied != verified || configured != verified || configured == LOCAL_VAULT {
            panic!("deployment build rejected: configured Squads vault does not match the pinned Devnet vault");
        }
    }
    let bytes = decode_pubkey(&configured)
        .unwrap_or_else(|error| panic!("invalid Squads vault authority: {error}"));
    let output = bytes
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let path =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set")).join("squads_vault.rs");
    fs::write(
        path,
        format!("pub const SQUADS_VAULT_AUTHORITY: Pubkey = Pubkey::new_from_array([{output}]);\n"),
    )
    .expect("write configured Squads vault authority");
}
