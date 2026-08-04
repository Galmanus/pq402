#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{vec, Env};

#[test]
fn the_policy_is_readable_by_whoever_must_obey_it() {
    let env = Env::default();
    let sac = Address::generate(&env);
    let id = env.register(
        AgentTreasury,
        (BytesN::from_array(&env, &[7u8; 32]), vec![&env, sac.clone()], 1_000_000i128),
    );
    let client = AgentTreasuryClient::new(&env, &id);
    let (allowed, cap, spent) = client.policy();
    assert_eq!(allowed, vec![&env, sac]);
    assert_eq!(cap, 1_000_000);
    assert_eq!(spent, 0);
    assert_eq!(client.remaining(), 1_000_000);
}

#[test]
fn the_window_rolls_off_on_ledger_time() {
    let env = Env::default();
    let sac = Address::generate(&env);
    let id = env.register(
        AgentTreasury,
        (BytesN::from_array(&env, &[7u8; 32]), vec![&env, sac], 1_000_000i128),
    );
    let client = AgentTreasuryClient::new(&env, &id);

    // Pretend a window is half consumed.
    env.as_contract(&id, || {
        env.storage().instance().set(&Key::Window, &(env.ledger().timestamp(), 600_000i128));
    });
    assert_eq!(client.remaining(), 400_000, "mid-window, the cap has bitten");

    env.ledger().with_mut(|l| l.timestamp += WINDOW);
    assert_eq!(client.remaining(), 1_000_000, "a full window later, it has rolled off");
}

// The two cases the sub-lane asks to see: one payment inside policy, one
// outside, and the second refused by the contract rather than by the client.
//
// These drive `__check_auth` directly with synthetic contexts, which is what
// the host does. The on-chain counterpart lives in `demo/policy.mjs`, where a
// real SAC transfer is authorized by this account and a real over-cap one is
// refused by consensus.

use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::{IntoVal, Val};

fn ctx(env: &Env, contract: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<Val> = vec![
        env,
        Address::generate(env).into_val(env),
        Address::generate(env).into_val(env),
        amount.into_val(env),
    ];
    vec![
        env,
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: symbol_short!("transfer"),
            args,
        }),
    ]
}

/// Setup returning (env, treasury id, the allowed SAC, the signing keypair's
/// public half). Signature checking is exercised by the host in production;
/// here the ed25519 verify is stubbed out by using the test env's own signer.
fn treasury(env: &Env, cap: i128) -> (Address, Address) {
    let sac = Address::generate(env);
    let id = env.register(
        AgentTreasury,
        (
            BytesN::from_array(env, &[9u8; 32]),
            vec![env, sac.clone()],
            cap,
        ),
    );
    (id, sac)
}

#[test]
fn a_call_into_an_unlisted_contract_is_refused() {
    let env = Env::default();
    env.mock_all_auths();
    let (id, _sac) = treasury(&env, 1_000_000);
    let stranger = Address::generate(&env);

    let out = env.as_contract(&id, || check_policy(&env, ctx(&env, &stranger, 1)));
    assert_eq!(
        out,
        Err(Error::ContractNotAllowed),
        "a treasury that authorizes calls into contracts it was never told \
         about has no allow-list, only a comment about one"
    );
}

#[test]
fn the_cap_admits_what_fits_and_refuses_what_does_not() {
    let env = Env::default();
    env.mock_all_auths();
    let (id, sac) = treasury(&env, 1_000_000);
    // Inside policy: accepted, and the window records it.
    let ok = env.as_contract(&id, || check_policy(&env, ctx(&env, &sac, 600_000)));
    assert_eq!(ok, Ok(()), "600000 of a 1000000 cap must pass");

    let client = AgentTreasuryClient::new(&env, &id);
    assert_eq!(client.remaining(), 400_000, "the window remembers");

    // Outside policy: refused, and refused for the stated reason.
    let refused = env.as_contract(&id, || check_policy(&env, ctx(&env, &sac, 500_000)));
    assert_eq!(
        refused,
        Err(Error::DailyCapExceeded),
        "500000 more against 400000 remaining must be refused by the contract"
    );
    assert_eq!(client.remaining(), 400_000, "a refusal must not consume budget");
}
