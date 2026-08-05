#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger};
use soroban_sdk::{vec, Address, Env, IntoVal, Symbol};

/// A treasury wired to a real token, so `pay` can actually move balance and the
/// tests exercise the on-chain path rather than a free function beside it.
///
/// Returns (env, treasury id, agent, token SAC id, token admin client). The
/// treasury is minted `funded` base units of the token so it has something to
/// spend.
fn setup(cap: i128, funded: i128) -> (Env, Address, Address, Address) {
    let env = Env::default();
    let agent = Address::generate(&env);

    // A real Stellar Asset Contract to move, and its admin, so balances mean
    // something and `transfer` behaves as it will on-chain.
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let token = sac.address();

    let id = env.register(
        AgentTreasury,
        (agent.clone(), vec![&env, token.clone()], cap),
    );

    // Fund the treasury by minting to it. The auth mock is scoped to the mint
    // and then cleared, so it does NOT leak into the test body — otherwise a
    // lingering `mock_all_auths` would silently satisfy the `require_auth`
    // that `without_the_agents_authorization` exists to see fail.
    env.mock_all_auths();
    let admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    admin.mint(&id, &funded);
    env.mock_auths(&[]); // nothing authorized until a test says so

    (env, id, agent, token)
}

#[test]
fn the_policy_is_readable_by_whoever_must_obey_it() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    let client = AgentTreasuryClient::new(&env, &id);
    let (allowed, cap, spent) = client.policy();
    assert_eq!(allowed, vec![&env, token]);
    assert_eq!(cap, 1_000_000);
    assert_eq!(spent, 0);
    assert_eq!(client.remaining(), 1_000_000);
}

#[test]
fn the_window_rolls_off_on_ledger_time() {
    let (env, id, _agent, _token) = setup(1_000_000, 5_000_000);
    let client = AgentTreasuryClient::new(&env, &id);

    // Pretend a window is half consumed.
    env.as_contract(&id, || {
        env.storage()
            .instance()
            .set(&Key::Window, &(env.ledger().timestamp(), 600_000i128));
    });
    assert_eq!(client.remaining(), 400_000, "mid-window, the cap has bitten");

    env.ledger().with_mut(|l| l.timestamp += WINDOW);
    assert_eq!(client.remaining(), 1_000_000, "a full window later, it has rolled off");
}

#[test]
fn a_payment_inside_policy_moves_the_balance_and_records_it() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &600_000);

    let coin = soroban_sdk::token::TokenClient::new(&env, &token);
    assert_eq!(coin.balance(&to), 600_000, "the recipient actually received it");
    assert_eq!(client.remaining(), 400_000, "the window remembers what was spent");
}

#[test]
fn pay_requires_the_agent_to_have_authorized_this_exact_call() {
    // The regression test for the open-drain finding. Without require_auth,
    // pay() moved funds for anyone; here we assert the auth the framework
    // recorded is the agent's, bound to (pay, token, to, amount).
    let (env, id, agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &200_000);

    let auths = env.auths();
    assert_eq!(auths.len(), 1, "exactly one authorizer");
    let (who, invocation) = &auths[0];
    assert_eq!(who, &agent, "the authorizer is the agent, not the caller");
    assert_eq!(
        invocation.function,
        AuthorizedFunction::Contract((
            id.clone(),
            Symbol::new(&env, "pay"),
            (token.clone(), to.clone(), 200_000i128).into_val(&env),
        )),
        "the signature is bound to this exact pay, so it cannot be replayed \
         with a different recipient or amount"
    );
}

#[test]
#[should_panic]
fn without_the_agents_authorization_pay_does_not_move_a_thing() {
    // No mock_all_auths, no mock for the agent: require_auth has nothing to
    // find and the call must fail before any transfer. This is the drain,
    // closed: the caller is not the agent, and the caller is not enough.
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    // Deliberately do NOT mock the agent's auth.
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);
    client.pay(&token, &to, &1); // panics: unauthorized
}

#[test]
fn a_call_into_an_unlisted_token_is_refused() {
    let (env, id, _agent, _token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let stranger = Address::generate(&env);
    let to = Address::generate(&env);

    let out = client.try_pay(&stranger, &to, &1);
    assert_eq!(
        out,
        Err(Ok(Error::ContractNotAllowed)),
        "a treasury that moves a token it was never told about has no \
         allow-list, only a comment about one"
    );
}

#[test]
fn the_cap_admits_what_fits_and_refuses_what_does_not() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &600_000);
    assert_eq!(client.remaining(), 400_000, "the window remembers");

    let refused = client.try_pay(&token, &to, &500_000);
    assert_eq!(
        refused,
        Err(Ok(Error::DailyCapExceeded)),
        "500000 more against 400000 remaining must be refused by the contract"
    );
    assert_eq!(client.remaining(), 400_000, "a refusal must not consume budget");

    let coin = soroban_sdk::token::TokenClient::new(&env, &token);
    assert_eq!(coin.balance(&to), 600_000, "the refused payment moved nothing");
}

#[test]
fn a_refusal_at_the_cap_leaves_the_next_payment_free_to_succeed() {
    // The cap is a ceiling on the window, not a latch: a rejected over-cap
    // payment must not poison what still fits.
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &900_000);
    assert_eq!(client.try_pay(&token, &to, &200_000), Err(Ok(Error::DailyCapExceeded)));
    // 100000 still fits under the 1000000 cap.
    client.pay(&token, &to, &100_000);
    assert_eq!(client.remaining(), 0);
}

#[test]
fn exactly_the_cap_is_allowed_but_one_over_is_not() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    // Off-by-one on a spend limit is the difference between a rule and a
    // suggestion. `spent + amount > cap` must admit equality.
    client.pay(&token, &to, &1_000_000);
    assert_eq!(client.remaining(), 0);
    assert_eq!(client.try_pay(&token, &to, &1), Err(Ok(Error::DailyCapExceeded)));
}

#[test]
fn a_non_positive_amount_is_refused_before_anything_moves() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    assert_eq!(client.try_pay(&token, &to, &0), Err(Ok(Error::BadAmount)));
    assert_eq!(client.try_pay(&token, &to, &-5), Err(Ok(Error::BadAmount)));
    assert_eq!(client.remaining(), 1_000_000, "a bad amount consumed no budget");
}

#[test]
fn spending_across_a_window_boundary_starts_a_fresh_budget() {
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &1_000_000);
    assert_eq!(client.remaining(), 0, "cap reached");
    assert_eq!(client.try_pay(&token, &to, &1), Err(Ok(Error::DailyCapExceeded)));

    env.ledger().with_mut(|l| l.timestamp += WINDOW);
    assert_eq!(client.remaining(), 1_000_000, "a new window, a new budget");
    client.pay(&token, &to, &1_000_000);

    let coin = soroban_sdk::token::TokenClient::new(&env, &token);
    assert_eq!(coin.balance(&to), 2_000_000, "two full windows' worth received");
}

#[test]
fn the_authorized_invocation_carries_no_unexpected_subtree() {
    // pay() authorizes the agent for pay itself; the treasury's own outgoing
    // transfer is authorized by the contract, so it must NOT appear as a
    // sub-invocation the agent had to sign for. If it did, an agent signing a
    // pay would be unwittingly signing a raw transfer too.
    let (env, id, _agent, token) = setup(1_000_000, 5_000_000);
    env.mock_all_auths();
    let client = AgentTreasuryClient::new(&env, &id);
    let to = Address::generate(&env);

    client.pay(&token, &to, &10);
    let (_who, invocation): &(Address, AuthorizedInvocation) = &env.auths()[0];
    assert_eq!(
        invocation.sub_invocations.len(),
        0,
        "the agent authorized pay, and only pay"
    );
}
