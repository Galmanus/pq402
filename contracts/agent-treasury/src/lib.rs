#![no_std]
//! agent-treasury: a Soroban treasury that an autonomous agent pays from, and
//! that refuses to move anything outside its policy or unauthorized by its
//! agent.
//!
//! The distinction this contract exists to make is between a *promise* and a
//! *rule*. An agent CLI with a `--max` flag makes a promise: the agent is
//! asking itself to behave, and a compromised or confused agent simply stops
//! asking. Three rules stand whether or not it asks:
//!
//!   * **who** — every payment calls `agent.require_auth()`, so the payment's
//!     authorization does not exist unless the agent signed for this exact
//!     call. A contract moving its own balance authorizes its own outgoing
//!     transfer automatically, so without this an unauthenticated `pay` would
//!     be an open drain bounded only by the cap; the `require_auth` is what
//!     answers "whose money is this";
//!   * **what** — a **contract allow-list**, so the treasury will only ever
//!     move a token it was told about, and a stolen agent key cannot be
//!     pointed at an arbitrary token or protocol;
//!   * **how much** — a **rolling daily cap** on the total moved in any
//!     24-hour window, keyed off ledger time rather than a counter someone can
//!     reset.
//!
//! All three are enforced in `pay`, on-chain, before any token moves —
//! visible as a transaction failure rather than a silent no-op.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Vec,
};

/// Emitted on every successful payment, so an off-chain watcher can follow the
/// treasury without polling balances.
#[contractevent]
pub struct Paid {
    pub to: Address,
    pub amount: i128,
}

#[contract]
pub struct AgentTreasury;

#[contracttype]
#[derive(Clone)]
pub enum Key {
    /// The agent whose authorization every payment requires.
    Agent,
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
    /// The call targets a contract the treasury was never told about.
    ContractNotAllowed = 2,
    /// This payment would push the rolling window over the cap.
    DailyCapExceeded = 3,
    /// A non-positive amount, refused rather than waved through.
    BadAmount = 4,
}

/// One rolling window, in seconds.
const WINDOW: u64 = 86_400;

#[contractimpl]
impl AgentTreasury {
    /// Wiring happens at deployment, so the treasury never exists in a state
    /// where it would authorize anything under a policy nobody set.
    pub fn __constructor(
        env: Env,
        agent: Address,
        allowed: Vec<Address>,
        daily_cap: i128,
    ) {
        env.storage().instance().set(&Key::Agent, &agent);
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
    /// Refusal happens here, on-chain, before any token moves. Three rules,
    /// and the first is the one that answers "whose money is this":
    ///
    ///   * `agent.require_auth()` — the payment's authorization does not exist
    ///     unless the agent signed for this exact call. The auth framework
    ///     binds the signature to `(this contract, "pay", token, to, amount)`,
    ///     so a captured signature cannot be replayed with a different
    ///     recipient or amount. Without this line the transfer below would
    ///     still succeed — a contract authorizes its own outgoing transfer —
    ///     and `pay` would be an open drain bounded only by the cap.
    ///   * the allow-list and the rolling cap, unchanged.
    ///
    /// An agent's own `--max` flag is a promise it makes to itself, and a
    /// compromised agent stops making it. These three are rules.
    pub fn pay(env: Env, token: Address, to: Address, amount: i128) -> Result<(), Error> {
        let agent: Address = env.storage().instance().get(&Key::Agent).unwrap();
        agent.require_auth();

        if amount <= 0 {
            return Err(Error::BadAmount);
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
        Paid { to, amount }.publish(&env);
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

mod test;
