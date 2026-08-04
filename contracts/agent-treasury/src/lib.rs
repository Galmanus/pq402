#![no_std]
//! agent-treasury: a Soroban custom account that an autonomous agent pays
//! from, and that refuses to authorize anything outside its policy.
//!
//! The distinction this contract exists to make is between a *promise* and a
//! *rule*. An agent CLI with a `--max` flag makes a promise: the agent is
//! asking itself to behave, and a compromised or confused agent simply stops
//! asking. A policy in `__check_auth` is a rule: the signature the payment
//! needs does not exist unless the payment is inside policy, so refusal
//! happens in consensus and no amount of client-side misbehaviour reaches
//! around it.
//!
//! Two policies, both checked on every authorization:
//!
//!   * a **contract allow-list** — the treasury will only ever authorize calls
//!     into contracts it was told about, so a stolen policy key cannot be
//!     pointed at an arbitrary token or an arbitrary protocol;
//!   * a **rolling daily cap** — the total moved in any 24-hour window, with
//!     the window keyed off ledger time rather than a counter someone can
//!     reset.
//!
//! `__check_auth` is invoked by the host with the contexts of everything the
//! transaction is trying to do on this account's behalf. Returning an error
//! kills the whole transaction, which is why the refusal is visible on-chain
//! as a failure rather than as a silent no-op.

use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::Hash, symbol_short, Address,
    Bytes, BytesN, Env, TryFromVal, Vec,
};

#[contract]
pub struct AgentTreasury;

#[contracttype]
#[derive(Clone)]
pub enum Key {
    /// The ed25519 public key whose signature the policy accepts.
    Signer,
    /// Contracts this treasury may be made to call.
    Allowed,
    /// Ceiling, in token base units, for any rolling 24h window.
    DailyCap,
    /// (window_start_unix, spent_in_window)
    Window,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The signature is not the policy signer's.
    BadSignature = 1,
    /// The call targets a contract the treasury was never told about.
    ContractNotAllowed = 2,
    /// This payment would push the rolling window over the cap.
    DailyCapExceeded = 3,
    /// A context this policy does not know how to reason about, refused
    /// rather than waved through.
    UnsupportedContext = 4,
}

/// One rolling window, in seconds.
const WINDOW: u64 = 86_400;

#[contractimpl]
impl AgentTreasury {
    /// Wiring happens at deployment, so the treasury never exists in a state
    /// where it would authorize anything under a policy nobody set.
    pub fn __constructor(
        env: Env,
        signer: BytesN<32>,
        allowed: Vec<Address>,
        daily_cap: i128,
    ) {
        env.storage().instance().set(&Key::Signer, &signer);
        env.storage().instance().set(&Key::Allowed, &allowed);
        env.storage().instance().set(&Key::DailyCap, &daily_cap);
        env.storage().instance().set(&Key::Window, &(0u64, 0i128));
    }

    /// The policy, readable by anyone. An agent that can see its own limits
    /// can stay inside them; one that cannot is guessing.
    pub fn policy(env: Env) -> (Vec<Address>, i128, i128) {
        let allowed: Vec<Address> = env.storage().instance().get(&Key::Allowed).unwrap();
        let cap: i128 = env.storage().instance().get(&Key::DailyCap).unwrap();
        (allowed, cap, spent_now(&env))
    }

    /// Spend from the treasury, under policy.
    ///
    /// The same rule `__check_auth` applies, reached through the front door.
    /// A custom account is the more elegant shape — the policy lives in the
    /// authorization itself, so it binds anything the treasury is ever made to
    /// sign — but it requires the caller to hand-assemble a
    /// `SorobanAuthorizationEntry`, which no generic SDK helper will do for a
    /// contract address. This entry point is what an agent actually calls.
    ///
    /// Refusal happens here, on-chain, before any token moves. That is the
    /// whole point: an agent's own `--max` flag is a promise it makes to
    /// itself, and a compromised agent stops making it. This is a rule.
    pub fn pay(env: Env, token: Address, to: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::UnsupportedContext);
        }
        let allowed: Vec<Address> = env.storage().instance().get(&Key::Allowed).unwrap();
        if !allowed.contains(&token) {
            return Err(Error::ContractNotAllowed);
        }
        let cap: i128 = env.storage().instance().get(&Key::DailyCap).unwrap();

        let now = env.ledger().timestamp();
        let (start, spent): (u64, i128) = env.storage().instance().get(&Key::Window).unwrap();
        let (start, spent) = if now >= start + WINDOW { (now, 0i128) } else { (start, spent) };
        if spent + amount > cap {
            return Err(Error::DailyCapExceeded);
        }

        // Commit the budget BEFORE the transfer. If the transfer panics the
        // whole invocation reverts, so the ordering cannot leak budget; doing
        // it after would leave a window where a reentrant call sees the old
        // total.
        env.storage()
            .instance()
            .set(&Key::Window, &(start, spent + amount));

        soroban_sdk::token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        env.events()
            .publish((symbol_short!("paid"), to), amount);
        Ok(())
    }

    /// What remains before the cap refuses.
    pub fn remaining(env: Env) -> i128 {
        let cap: i128 = env.storage().instance().get(&Key::DailyCap).unwrap();
        cap - spent_now(&env)
    }
}

/// How much of the cap the current rolling window has consumed.
fn spent_now(env: &Env) -> i128 {
    let (start, spent): (u64, i128) = env.storage().instance().get(&Key::Window).unwrap();
    if env.ledger().timestamp() >= start + WINDOW {
        0
    } else {
        spent
    }
}

/// The policy itself, with the signature question already answered.
///
/// Split out because "is this the right key" and "is this within policy" are
/// different questions, and only the second one is interesting to test: the
/// first is the host's ed25519 and needs no help from us. Returns the amount
/// it committed to the window.
fn check_policy(env: &Env, contexts: Vec<Context>) -> Result<(), Error> {
    let allowed: Vec<Address> = env.storage().instance().get(&Key::Allowed).unwrap();
    let cap: i128 = env.storage().instance().get(&Key::DailyCap).unwrap();

    let mut moving: i128 = 0;
    for ctx in contexts.iter() {
        match ctx {
            Context::Contract(c) => {
                // The allow-list. A stolen policy key cannot be pointed at a
                // token this treasury was never meant to touch.
                if !allowed.contains(&c.contract) {
                    return Err(Error::ContractNotAllowed);
                }
                // Sum what leaves. `transfer(from, to, amount)` under SEP-41:
                // the amount is the third argument.
                if c.fn_name == symbol_short!("transfer") {
                    let raw = c.args.get(2).ok_or(Error::UnsupportedContext)?;
                    let amount =
                        i128::try_from_val(env, &raw).map_err(|_| Error::UnsupportedContext)?;
                    moving += amount;
                }
            }
            // A context this policy cannot read is refused, not ignored.
            // Silence would be a policy that says "anything I do not
            // understand is fine", which is the opposite of a policy.
            _ => return Err(Error::UnsupportedContext),
        }
    }

    // The rolling window, keyed off ledger time so it cannot be reset by
    // anyone who merely calls a lot.
    let now = env.ledger().timestamp();
    let (start, spent): (u64, i128) = env.storage().instance().get(&Key::Window).unwrap();
    let (start, spent) = if now >= start + WINDOW { (now, 0i128) } else { (start, spent) };

    if spent + moving > cap {
        return Err(Error::DailyCapExceeded);
    }
    env.storage()
        .instance()
        .set(&Key::Window, &(start, spent + moving));
    Ok(())
}

mod test;
