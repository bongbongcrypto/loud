//! Unit tests. They run against the mocked NEAR environment of near-sdk.
//!
//! The mocked storage is per thread and survives `testing_env!`, so every
//! test deploys at most one live contract per thread.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;
use std::panic::{catch_unwind, AssertUnwindSafe};

const E18: u128 = 1_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MINUTE: u64 = 60 * SECOND_NS;
/// The storage fee, written out so a change of the constant shows up here.
const STORAGE_FEE: u128 = 30_000_000_000_000_000_000_000;
const T0: u64 = 1_700_000_000 * SECOND_NS;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn token() -> AccountId {
    acc("loud.test")
}

fn creator() -> AccountId {
    acc("creator.test")
}

/// Sets the caller, block time and attached deposit for the next call.
fn at(who: &AccountId, ts: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(token())
        .signer_account_id(who.clone())
        .predecessor_account_id(who.clone())
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000_000));
    testing_env!(b.build());
}

/// Sets up a callback: the token account calls itself at `ts` and sees
/// `result` as the result of the promise it waited for.
fn at_callback(ts: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(token())
        .signer_account_id(token())
        .predecessor_account_id(token())
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(0))
        .account_balance(NearToken::from_near(1_000_000_000));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

#[derive(Clone)]
struct Cfg {
    supply: u128,
    creator_bps: u16,
    virtual_near: u128,
    loud_window: u64,
    notice: u64,
    exit_window: u64,
    cap_bps: u16,
    cap_window: u64,
}

/// The `standard` preset of SPEC 3.
fn standard() -> Cfg {
    Cfg {
        supply: 1_000_000_000 * E18,
        creator_bps: 500,
        virtual_near: 100 * NEAR,
        loud_window: 10 * MINUTE,
        notice: 30 * MINUTE,
        exit_window: 60 * MINUTE,
        cap_bps: 50,
        cap_window: 60 * MINUTE,
    }
}

/// The `demo` preset of SPEC 3.
fn demo() -> Cfg {
    Cfg {
        supply: 1_000_000_000 * E18,
        creator_bps: 500,
        virtual_near: 5 * NEAR,
        loud_window: 2 * MINUTE,
        notice: MINUTE,
        exit_window: 10 * MINUTE,
        cap_bps: 50,
        cap_window: 10 * MINUTE,
    }
}

fn deploy(cfg: &Cfg) -> Loud {
    deploy_as(cfg, creator(), "Loud", "LOUD", None)
}

fn deploy_as(cfg: &Cfg, creator_id: AccountId, name: &str, symbol: &str, icon: Option<String>) -> Loud {
    at(&creator(), T0, 0);
    Loud::new(
        U128(cfg.supply),
        creator_id,
        cfg.creator_bps,
        U128(cfg.virtual_near),
        U64(cfg.loud_window),
        U64(cfg.notice),
        U64(cfg.exit_window),
        cfg.cap_bps,
        U64(cfg.cap_window),
        name.to_string(),
        symbol.to_string(),
        icon,
    )
}

/// Runs `f` and checks that it stops with a message starting with `code:`.
fn expect_fail<R>(code: &str, f: impl FnOnce() -> R) {
    let err = match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected {code}, but the call succeeded"),
        Err(e) => e,
    };
    let msg = if let Some(s) = err.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = err.downcast_ref::<&str>() {
        s.to_string()
    } else {
        String::new()
    };
    assert!(msg.starts_with(&format!("{code}:")), "expected {code}, got: {msg}");
}

/// Registers `who` with the exact storage fee, paid by `who`.
fn register(c: &mut Loud, who: &AccountId, ts: u64) {
    at(who, ts, STORAGE_FEE);
    c.storage_deposit(None, None);
}

/// Buys with `near` reaching the pool. A caller that is not registered yet
/// attaches the storage fee on top, as a first buy does.
fn buy(c: &mut Loud, who: &AccountId, ts: u64, near: u128) -> u128 {
    let fee = if c.is_registered(who.clone()) { 0 } else { STORAGE_FEE };
    at(who, ts, near + fee);
    c.buy(U128(0)).0
}

fn sell(c: &mut Loud, who: &AccountId, ts: u64, amount: u128) -> u128 {
    at(who, ts, 1);
    c.sell(U128(amount), U128(0)).0
}

fn shout(c: &mut Loud, who: &AccountId, ts: u64, amount: u128) -> u64 {
    at(who, ts, 1);
    c.shout(U128(amount)).0
}

fn leave(c: &mut Loud, who: &AccountId, ts: u64, id: u64) -> u128 {
    at(who, ts, 1);
    c.leave(U64(id), U128(0)).0
}

fn hush(c: &mut Loud, who: &AccountId, ts: u64, id: u64) {
    at(who, ts, 1);
    c.hush(U64(id));
}

fn state(c: &Loud, ts: u64) -> State {
    at(&token(), ts, 0);
    c.get_state()
}

/// `(loud, quiet)` of an account.
fn bal(c: &Loud, who: &AccountId) -> (u128, u128) {
    let a = c.get_account(who.clone());
    (a.loud.0, a.quiet.0)
}

/// YoctoNEAR sent out by the last call.
fn transfers_out() -> u128 {
    let mut total = 0u128;
    for receipt in get_created_receipts() {
        for action in receipt.actions.iter() {
            if let MockAction::Transfer { deposit, .. } = action {
                total += deposit.as_yoctonear();
            }
        }
    }
    total
}

/// YoctoNEAR sent to `who` by the last call.
fn paid_to(who: &AccountId) -> u128 {
    let mut total = 0u128;
    for receipt in get_created_receipts() {
        if receipt.receiver_id != *who {
            continue;
        }
        for action in receipt.actions.iter() {
            if let MockAction::Transfer { deposit, .. } = action {
                total += deposit.as_yoctonear();
            }
        }
    }
    total
}

/// `(receiver, method)` of every function call scheduled by the last call.
fn calls_out() -> Vec<(AccountId, String)> {
    let mut calls = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions.iter() {
            if let MockAction::FunctionCallWeight { method_name, .. } = action {
                calls.push((
                    receipt.receiver_id.clone(),
                    String::from_utf8_lossy(method_name).to_string(),
                ));
            }
        }
    }
    calls
}

fn logged(fragment: &str) -> bool {
    get_logs().iter().any(|l| l.contains(fragment))
}

fn has_event(name: &str) -> bool {
    logged(&format!("\"event\":\"{name}\""))
}

// Init

#[test]
fn new_sets_the_documented_state() {
    let cfg = standard();
    let c = deploy(&cfg);
    assert!(has_event("ft_mint"));
    assert!(logged("\"standard\":\"nep141\""));
    assert!(logged("\"owner_id\":\"creator.test\""));
    assert!(logged("\"owner_id\":\"loud.test\""));

    let p = c.get_params();
    assert_eq!(p.total_supply.0, cfg.supply);
    assert_eq!(p.creator, creator());
    assert_eq!(p.creator_alloc.0, 50_000_000 * E18);
    assert_eq!(p.cap_units.0, 5_000_000 * E18);
    assert_eq!(p.launch_ts.0, T0);
    assert_eq!(p.loud_until.0, T0 + 10 * MINUTE);
    assert_eq!(p.creator_alloc_bps, 500);
    assert_eq!(p.cap_bps, 50);

    let s = state(&c, T0);
    assert_eq!(s.pool_tokens.0, 950_000_000 * E18);
    assert_eq!(s.pool_near.0, 0);
    assert_eq!(s.loud_outstanding.0, 50_000_000 * E18);
    assert_eq!(s.escrowed.0, 0);
    assert_eq!(s.cap_available.0, 0, "the bucket starts empty");
    assert_eq!(s.open_exits, 0);
    assert!(s.is_loud_window);
    assert_eq!(s.cap_full_ts.0, T0 + 60 * MINUTE);

    assert_eq!(bal(&c, &creator()), (50_000_000 * E18, 0));
    assert_eq!(c.ft_balance_of(creator()).0, 50_000_000 * E18);
    assert_eq!(c.ft_total_supply().0, cfg.supply);
    // The creator is registered by `new` and nobody else is.
    assert!(c.is_registered(creator()));
    assert!(!c.is_registered(acc("anyone.test")));
    let m = c.ft_metadata();
    assert_eq!(m.spec, "ft-1.0.0");
    assert_eq!(m.decimals, 18);
    assert_eq!(m.symbol, "LOUD");

    // The bucket fills linearly and stops at the cap.
    assert_eq!(state(&c, T0 + 15 * MINUTE).cap_available.0, 1_250_000 * E18);
    assert_eq!(state(&c, T0 + 600 * MINUTE).cap_available.0, 5_000_000 * E18);
    assert!(!state(&c, T0 + 10 * MINUTE).is_loud_window);
}

#[test]
fn new_accepts_the_bounds() {
    let seven_days = 7 * 24 * 60 * MINUTE;
    let low = Cfg {
        supply: 10u128.pow(24),
        creator_bps: 0,
        virtual_near: 10u128.pow(23),
        loud_window: MINUTE,
        notice: 30 * SECOND_NS,
        exit_window: MINUTE,
        cap_bps: 1,
        cap_window: MINUTE,
    };
    let c = deploy(&low);
    assert_eq!(c.get_params().creator_alloc.0, 0);
    assert_eq!(c.get_params().cap_units.0, 10u128.pow(20));
    drop(c);

    let high = Cfg {
        supply: 10u128.pow(30),
        creator_bps: 2_000,
        virtual_near: 10u128.pow(30),
        loud_window: seven_days,
        notice: seven_days,
        exit_window: seven_days,
        cap_bps: 1_000,
        cap_window: seven_days,
    };
    let c = deploy(&high);
    assert_eq!(c.get_params().creator_alloc.0, 2 * 10u128.pow(29));
    assert_eq!(c.get_params().cap_units.0, 10u128.pow(29));
}

#[test]
fn new_rejects_out_of_bounds_params() {
    let seven_days = 7 * 24 * 60 * MINUTE;
    let base = standard();
    let mut bad: Vec<Cfg> = Vec::new();
    bad.push(Cfg { supply: 10u128.pow(24) - 1, ..base.clone() });
    bad.push(Cfg { supply: 10u128.pow(30) + 1, ..base.clone() });
    bad.push(Cfg { creator_bps: 2_001, ..base.clone() });
    bad.push(Cfg { virtual_near: 10u128.pow(23) - 1, ..base.clone() });
    bad.push(Cfg { virtual_near: 10u128.pow(30) + 1, ..base.clone() });
    bad.push(Cfg { loud_window: MINUTE - 1, ..base.clone() });
    bad.push(Cfg { loud_window: seven_days + 1, ..base.clone() });
    bad.push(Cfg { notice: 30 * SECOND_NS - 1, ..base.clone() });
    bad.push(Cfg { notice: seven_days + 1, ..base.clone() });
    bad.push(Cfg { exit_window: MINUTE - 1, ..base.clone() });
    bad.push(Cfg { exit_window: seven_days + 1, ..base.clone() });
    bad.push(Cfg { cap_bps: 0, ..base.clone() });
    bad.push(Cfg { cap_bps: 1_001, ..base.clone() });
    bad.push(Cfg { cap_window: MINUTE - 1, ..base.clone() });
    bad.push(Cfg { cap_window: seven_days + 1, ..base.clone() });
    for cfg in bad.iter() {
        expect_fail("E_PARAMS", || deploy(cfg));
    }
}

#[test]
fn new_rejects_the_token_account_as_creator() {
    let cfg = standard();
    expect_fail("E_PARAMS", || deploy_as(&cfg, token(), "Loud", "LOUD", None));
}

#[test]
fn new_caps_the_metadata_sizes() {
    let cfg = standard();
    let icon = |bytes: usize| Some("i".repeat(bytes));
    expect_fail("E_PARAMS", || deploy_as(&cfg, creator(), &"n".repeat(65), "LOUD", None));
    expect_fail("E_PARAMS", || deploy_as(&cfg, creator(), "Loud", &"S".repeat(17), None));
    expect_fail("E_PARAMS", || deploy_as(&cfg, creator(), "Loud", "LOUD", icon(2_049)));
    // The limits count bytes: 33 two-byte letters are 66 bytes.
    expect_fail("E_PARAMS", || deploy_as(&cfg, creator(), &"\u{e9}".repeat(33), "LOUD", None));

    // Exactly at the limits is fine.
    let c = deploy_as(&cfg, creator(), &"n".repeat(64), &"S".repeat(16), icon(2_048));
    let m = c.ft_metadata();
    assert_eq!(m.name.len(), 64);
    assert_eq!(m.symbol.len(), 16);
    assert_eq!(m.icon.map(|i| i.len()), Some(2_048));
}

#[test]
fn new_is_callable_once() {
    let cfg = standard();
    let c = deploy(&cfg);
    // The generated wrapper writes the state after `new`; do the same here.
    env::state_write(&c);
    expect_fail("E_INIT", || deploy(&cfg));
}

// Trading

#[test]
fn buy_is_loud_inside_the_window_and_quiet_after() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    let early = acc("early.test");
    let late = acc("late.test");

    // Inside the window: loud.
    at(&early, T0 + SECOND_NS, 0);
    let quote = c.quote_buy(U128(10 * NEAR)).0;
    let out = buy(&mut c, &early, T0 + SECOND_NS, 10 * NEAR);
    assert_eq!(out, quote);
    assert_eq!(out, loud_math::mul_div(950_000_000 * E18, 10 * NEAR, 110 * NEAR));
    assert!(has_event("buy"));
    assert!(logged("\"loud\":true"));
    assert!(has_event("ft_transfer"));
    assert_eq!(bal(&c, &early), (out, 0));
    let s = state(&c, T0 + SECOND_NS);
    assert_eq!(s.pool_near.0, 10 * NEAR);
    assert_eq!(s.pool_tokens.0, 950_000_000 * E18 - out);
    assert_eq!(s.loud_outstanding.0, 50_000_000 * E18 + out);

    // Last nanosecond of the window: still loud.
    let last = T0 + 10 * MINUTE - 1;
    let out2 = buy(&mut c, &early, last, NEAR);
    assert_eq!(bal(&c, &early), (out + out2, 0));

    // At `loud_until`: quiet, and loud_outstanding does not move.
    let before = state(&c, T0 + 10 * MINUTE).loud_outstanding.0;
    let out3 = buy(&mut c, &late, T0 + 10 * MINUTE, 5 * NEAR);
    assert!(logged("\"loud\":false"));
    assert_eq!(bal(&c, &late), (0, out3));
    assert_eq!(state(&c, T0 + 10 * MINUTE).loud_outstanding.0, before);
}

#[test]
fn first_buy_registers_the_caller_and_keeps_the_fee_out_of_the_pool() {
    let mut c = deploy(&standard());
    let alice = acc("alice.test");
    let ts = T0 + SECOND_NS;
    assert!(!c.is_registered(alice.clone()));

    // The deposit must cover the fee and the smallest buy on top of it.
    at(&alice, ts, STORAGE_FEE - 1);
    expect_fail("E_DEPOSIT", || c.buy(U128(0)));
    at(&alice, ts, STORAGE_FEE + 10u128.pow(21) - 1);
    expect_fail("E_DEPOSIT", || c.buy(U128(0)));
    // A buy that fails for another reason does not register either.
    at(&alice, ts, STORAGE_FEE + NEAR);
    let quote = c.quote_buy(U128(NEAR)).0;
    expect_fail("E_SLIPPAGE", || c.buy(U128(quote + 1)));
    assert!(!c.is_registered(alice.clone()));
    assert_eq!(state(&c, ts).pool_near.0, 0);

    // Only the part above the fee is priced and enters the pool.
    at(&alice, ts, STORAGE_FEE + NEAR);
    assert_eq!(c.buy(U128(quote)).0, quote);
    assert!(logged(&format!("\"near_in\":\"{NEAR}\"")));
    assert!(logged(&format!("\"storage_paid\":\"{STORAGE_FEE}\"")));
    assert_eq!(transfers_out(), 0);
    assert!(c.is_registered(alice.clone()));
    assert_eq!(bal(&c, &alice), (quote, 0));
    assert_eq!(state(&c, ts).pool_near.0, NEAR);

    // The fee is paid once: the next buy goes to the pool in full.
    at(&alice, ts, NEAR);
    c.buy(U128(0));
    assert!(logged(&format!("\"near_in\":\"{NEAR}\"")));
    assert!(logged("\"storage_paid\":\"0\""));
    assert_eq!(state(&c, ts).pool_near.0, 2 * NEAR);

    // An account registered through storage_deposit pays no fee in buy.
    let bob = acc("bob.test");
    register(&mut c, &bob, ts);
    at(&bob, ts, NEAR);
    c.buy(U128(0));
    assert!(logged("\"storage_paid\":\"0\""));
    assert_eq!(state(&c, ts).pool_near.0, 3 * NEAR);
}

#[test]
fn buy_checks_deposit_and_slippage() {
    let mut c = deploy(&standard());
    let alice = acc("alice.test");
    register(&mut c, &alice, T0 + 1);
    at(&alice, T0 + 1, 10u128.pow(21) - 1);
    expect_fail("E_DEPOSIT", || c.buy(U128(0)));
    at(&alice, T0 + 1, 0);
    expect_fail("E_DEPOSIT", || c.buy(U128(0)));
    at(&alice, T0 + 1, NEAR);
    let quote = c.quote_buy(U128(NEAR)).0;
    expect_fail("E_SLIPPAGE", || c.buy(U128(quote + 1)));
    // The exact quote is accepted.
    at(&alice, T0 + 1, NEAR);
    assert_eq!(c.buy(U128(quote)).0, quote);
}

#[test]
fn pool_buyer_after_the_window_is_quiet_and_can_sell_at_once() {
    // SPEC 8.3
    let cfg = standard();
    let mut c = deploy(&cfg);
    let dave = acc("dave.test");
    let ts = T0 + 11 * MINUTE;
    let out = buy(&mut c, &dave, ts, 20 * NEAR);
    assert_eq!(bal(&c, &dave), (0, out));

    at(&dave, ts, 0);
    let quote = c.quote_sell(U128(out)).0;
    let near_out = sell(&mut c, &dave, ts, out);
    assert_eq!(near_out, quote);
    assert_eq!(transfers_out(), near_out);
    assert!(has_event("sell"));
    assert!(near_out <= 20 * NEAR && near_out > 20 * NEAR - 1_000);
    assert_eq!(bal(&c, &dave), (0, 0));
    let s = state(&c, ts);
    assert_eq!(s.pool_tokens.0, 950_000_000 * E18);
    assert_eq!(s.pool_near.0, 20 * NEAR - near_out);
}

#[test]
fn sell_rejects_loud_tokens() {
    let mut c = deploy(&standard());
    let early = acc("early.test");
    let out = buy(&mut c, &early, T0 + SECOND_NS, 10 * NEAR);
    assert_eq!(bal(&c, &early), (out, 0));
    // Loud only: nothing to sell, even long after the window.
    at(&early, T0 + 600 * MINUTE, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(out), U128(0)));
    at(&early, T0 + 600 * MINUTE, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(1), U128(0)));
    // The creator allocation is loud as well.
    at(&creator(), T0 + 600 * MINUTE, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(E18), U128(0)));
    // The message names both balances and the way out.
    at(&early, T0 + 600 * MINUTE, 1);
    let err = catch_unwind(AssertUnwindSafe(|| c.sell(U128(out), U128(0)))).unwrap_err();
    let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(msg.contains(&format!("{out} loud")), "{msg}");
    assert!(msg.contains("0 quiet"), "{msg}");
    assert!(msg.contains("shout"), "{msg}");
}

#[test]
fn sell_checks_yocto_amount_and_slippage() {
    let mut c = deploy(&standard());
    let dave = acc("dave.test");
    let ts = T0 + 11 * MINUTE;
    let out = buy(&mut c, &dave, ts, 20 * NEAR);
    at(&dave, ts, 0);
    expect_fail("E_YOCTO", || c.sell(U128(out), U128(0)));
    at(&dave, ts, 2);
    expect_fail("E_YOCTO", || c.sell(U128(out), U128(0)));
    at(&dave, ts, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(out + 1), U128(0)));
    at(&dave, ts, 1);
    expect_fail("E_AMOUNT", || c.sell(U128(0), U128(0)));
    at(&dave, ts, 1);
    expect_fail("E_SLIPPAGE", || c.sell(U128(out), U128(20 * NEAR + 1)));
    // One unit is worth less than 1 yoctoNEAR here: nothing is taken.
    at(&dave, ts, 1);
    expect_fail("E_AMOUNT", || c.sell(U128(1), U128(0)));
    assert_eq!(bal(&c, &dave), (0, out));
}

// shout / leave / hush

/// Standard launch, a 1000 NEAR buy so the pool can pay, then the creator
/// shouts 20M tokens (four caps) at T0 + 2 s. Returns the exit id.
fn launch_with_shout() -> (Loud, u64, u64) {
    let cfg = standard();
    let mut c = deploy(&cfg);
    buy(&mut c, &acc("whale.test"), T0 + SECOND_NS, 1_000 * NEAR);
    let t_shout = T0 + 2 * SECOND_NS;
    let id = shout(&mut c, &creator(), t_shout, 20_000_000 * E18);
    (c, id, t_shout + cfg.notice)
}

#[test]
fn shout_escrows_and_publishes_the_exit() {
    let (c, id, ready) = launch_with_shout();
    assert_eq!(id, 1);
    assert!(has_event("shout"));
    assert!(logged("\"ready_at\":\""));
    assert_eq!(bal(&c, &creator()), (30_000_000 * E18, 0));
    assert_eq!(c.ft_balance_of(creator()).0, 30_000_000 * E18);

    let s = state(&c, T0 + 2 * SECOND_NS);
    assert_eq!(s.escrowed.0, 20_000_000 * E18);
    assert_eq!(s.open_exits, 1);
    assert_eq!(s.total_shouted.0, 20_000_000 * E18);
    assert_eq!(s.shout_count, 1);

    let exits = c.get_exits(0, 100);
    assert_eq!(exits.len(), 1);
    let e = &exits[0];
    assert_eq!(e.id.0, 1);
    assert_eq!(e.owner, creator());
    assert_eq!(e.amount.0, 20_000_000 * E18);
    assert_eq!(e.remaining.0, 20_000_000 * E18);
    assert_eq!(e.shouted_at.0, T0 + 2 * SECOND_NS);
    assert_eq!(e.ready_at.0, ready);
    assert_eq!(e.expires_at.0, ready + 60 * MINUTE);
    assert_eq!(c.get_account(creator()).exits, exits);
}

#[test]
fn shout_checks_balance_dust_and_exit_count() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    let ts = T0 + SECOND_NS;
    let dust = 1_000 * E18; // total_supply / 1_000_000
    at(&creator(), ts, 0);
    expect_fail("E_YOCTO", || c.shout(U128(dust)));
    at(&creator(), ts, 1);
    expect_fail("E_NO_LOUD", || c.shout(U128(0)));
    at(&creator(), ts, 1);
    expect_fail("E_NO_LOUD", || c.shout(U128(50_000_000 * E18 + 1)));
    at(&acc("nobody.test"), ts, 1);
    expect_fail("E_NO_LOUD", || c.shout(U128(dust)));
    at(&creator(), ts, 1);
    expect_fail("E_DUST", || c.shout(U128(dust - 1)));

    for expected in 1..=8u64 {
        assert_eq!(shout(&mut c, &creator(), ts, dust), expected);
    }
    at(&creator(), ts, 1);
    expect_fail("E_TOO_MANY", || c.shout(U128(dust)));
    assert_eq!(state(&c, ts).open_exits, 8);
    assert_eq!(c.get_account(creator()).exits.len(), 8);

    // The slots stay taken until an exit is closed, and an exit that was
    // never sold can only be closed after it expired.
    let expired = ts + cfg.notice + cfg.exit_window + 1;
    at(&creator(), expired, 1);
    expect_fail("E_TOO_MANY", || c.shout(U128(dust)));
    hush(&mut c, &creator(), expired, 3);
    assert_eq!(shout(&mut c, &creator(), expired, dust), 9);
    // get_exits stays ordered by id after a removal, and pages.
    let ids: Vec<u64> = c.get_exits(0, 100).iter().map(|e| e.id.0).collect();
    assert_eq!(ids, vec![1, 2, 4, 5, 6, 7, 8, 9]);
    let ids: Vec<u64> = c.get_exits(2, 3).iter().map(|e| e.id.0).collect();
    assert_eq!(ids, vec![4, 5, 6]);
    assert_eq!(c.get_exits(0, 1_000).len(), 8);
}

#[test]
fn shout_accepts_a_whole_balance_below_the_dust_floor() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    let ts = T0 + SECOND_NS;
    let dust = 1_000 * E18;
    // At this pool price one unit is worth less than one yoctoNEAR.
    buy(&mut c, &acc("minnow.test"), ts, NEAR);
    let small = acc("small.test");
    register(&mut c, &small, ts);
    at(&creator(), ts, 1);
    c.transfer_loud(small.clone(), U128(dust - 1));

    // A part of a balance below the floor is still refused.
    at(&small, ts, 1);
    expect_fail("E_DUST", || c.shout(U128(dust - 2)));
    assert_eq!(bal(&c, &small), (dust - 1, 0));
    // The whole balance goes through the door like any other exit.
    let id = shout(&mut c, &small, ts, dust - 1);
    assert_eq!(bal(&c, &small), (0, 0));
    assert_eq!(c.get_account(small.clone()).exits[0].remaining.0, dust - 1);
    let ready = ts + cfg.notice;
    at(&small, ready, 0);
    let quote = c.quote_sell(U128(dust - 1)).0;
    assert!(quote > 0);
    assert_eq!(leave(&mut c, &small, ready, id), dust - 1);
    assert_eq!(transfers_out(), quote);
    assert!(c.get_account(small.clone()).exits.is_empty());

    // One unit: the shout is accepted, the sale would pay 0 yoctoNEAR, so
    // leave stops with E_AMOUNT. The unit comes back through hush once the
    // exit has expired.
    let tiny = acc("tiny.test");
    register(&mut c, &tiny, ready);
    at(&creator(), ready, 1);
    c.transfer_loud(tiny.clone(), U128(1));
    let id = shout(&mut c, &tiny, ready, 1);
    assert_eq!(bal(&c, &tiny), (0, 0));
    let later = ready + cfg.notice;
    at(&tiny, later, 1);
    expect_fail("E_AMOUNT", || c.leave(U64(id), U128(0)));
    assert_eq!(state(&c, later).escrowed.0, 1);
    let expired = later + cfg.exit_window + 1;
    hush(&mut c, &tiny, expired, id);
    assert_eq!(bal(&c, &tiny), (1, 0));
    assert_eq!(state(&c, expired).escrowed.0, 0);
}

#[test]
fn shout_below_the_dust_floor_needs_an_account_with_no_open_exit() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    let ts = T0 + SECOND_NS;
    let dust = 1_000 * E18;
    buy(&mut c, &acc("minnow.test"), ts, NEAR);
    let small = acc("small.test");
    register(&mut c, &small, ts);
    at(&creator(), ts, 1);
    c.transfer_loud(small.clone(), U128(2 * dust - 1));

    // One exit is open. What is left is the whole balance and below the
    // floor: refused while that exit is open.
    let first = shout(&mut c, &small, ts, dust);
    assert_eq!(bal(&c, &small), (dust - 1, 0));
    at(&small, ts, 1);
    expect_fail("E_DUST", || c.shout(U128(dust - 1)));
    assert_eq!(bal(&c, &small), (dust - 1, 0));
    assert_eq!(c.get_account(small.clone()).exits.len(), 1);

    // The open exit sells out and closes. Now the remainder is accepted.
    let ready = ts + cfg.notice;
    assert_eq!(leave(&mut c, &small, ready, first), dust);
    assert!(c.get_account(small.clone()).exits.is_empty());
    let second = shout(&mut c, &small, ready, dust - 1);
    assert_eq!(bal(&c, &small), (0, 0));
    let exits = c.get_account(small.clone()).exits;
    assert_eq!(exits.len(), 1);
    assert_eq!((exits[0].id.0, exits[0].remaining.0), (second, dust - 1));
}

#[test]
fn leave_waits_for_the_notice() {
    let (mut c, id, ready) = launch_with_shout();
    at(&creator(), ready - 1, 1);
    expect_fail("E_NOTICE", || c.leave(U64(id), U128(0)));
    at(&creator(), ready - 90 * SECOND_NS, 1);
    let err = catch_unwind(AssertUnwindSafe(|| c.leave(U64(id), U128(0)))).unwrap_err();
    let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(msg.contains("90 s"), "{msg}");
    // Nothing moved.
    assert_eq!(state(&c, ready - 1).total_left.0, 0);
}

#[test]
fn leave_fills_up_to_the_cap_and_pays_near() {
    let (mut c, id, ready) = launch_with_shout();
    let cap = 5_000_000 * E18;
    let before = state(&c, ready);
    let room = before.cap_available.0;
    // The bucket filled since launch: (2 s + 30 min) of a 60 min window.
    // Refilled at T0 + 1 s (the buy), T0 + 2 s (the shout) and now.
    assert_eq!(room, 2 * loud_math::mul_div(cap, 1, 3_600) + cap / 2);

    at(&creator(), ready, 0);
    let quote = c.quote_sell(U128(room)).0;
    let filled = leave(&mut c, &creator(), ready, id);
    assert_eq!(filled, room);
    assert_eq!(transfers_out(), quote);
    assert!(has_event("leave"));

    let s = state(&c, ready);
    assert_eq!(s.cap_available.0, 0);
    assert_eq!(s.total_left.0, room);
    assert_eq!(s.leave_count, 1);
    assert_eq!(s.escrowed.0, 20_000_000 * E18 - room);
    assert_eq!(s.loud_outstanding.0, before.loud_outstanding.0 - room);
    assert_eq!(s.pool_tokens.0, before.pool_tokens.0 + room);
    assert_eq!(s.pool_near.0, before.pool_near.0 - quote);
    assert_eq!(s.next_room_ts.0, ready + 1);
    assert_eq!(s.cap_full_ts.0, ready + 60 * MINUTE);
    assert_eq!(c.get_exits(0, 100)[0].remaining.0, 20_000_000 * E18 - room);
    // Sold tokens are not handed back to the seller in any form.
    assert_eq!(bal(&c, &creator()), (30_000_000 * E18, 0));

    // Same block time: no room left.
    at(&creator(), ready, 1);
    expect_fail("E_CAP", || c.leave(U64(id), U128(0)));

    // Six minutes later a tenth of the cap is back.
    let filled = leave(&mut c, &creator(), ready + 6 * MINUTE, id);
    assert_eq!(filled, cap / 10);
}

#[test]
fn leave_checks_owner_expiry_slippage_and_id() {
    let (mut c, id, ready) = launch_with_shout();
    at(&acc("whale.test"), ready, 1);
    expect_fail("E_NOT_OWNER", || c.leave(U64(id), U128(0)));
    at(&creator(), ready, 1);
    expect_fail("E_NO_EXIT", || c.leave(U64(99), U128(0)));
    at(&creator(), ready, 0);
    expect_fail("E_YOCTO", || c.leave(U64(id), U128(0)));
    at(&creator(), ready, 1);
    expect_fail("E_SLIPPAGE", || c.leave(U64(id), U128(1_000_000 * NEAR)));

    // The last valid moment is `expires_at` itself.
    let expires = ready + 60 * MINUTE;
    assert!(leave(&mut c, &creator(), expires, id) > 0);
    at(&creator(), expires + 1, 1);
    expect_fail("E_EXPIRED", || c.leave(U64(id), U128(0)));
}

#[test]
fn leave_scales_the_price_limit_to_the_part_filled() {
    let (mut c, id, ready) = launch_with_shout();
    let whole = 20_000_000 * E18;
    let room = state(&c, ready).cap_available.0;
    assert!(room > 0 && room < whole);
    let quote_whole = c.quote_sell(U128(whole)).0;
    let quote_room = c.quote_sell(U128(room)).0;
    assert!(quote_whole > quote_room, "an absolute limit could not pass");
    // The highest limit this fill meets: floor(near_out * remaining / fill).
    let edge = loud_math::mul_div(quote_room, whole, room);
    assert!(edge >= quote_whole);

    // One yoctoNEAR above the pro-rata quote fails and moves nothing.
    at(&creator(), ready, 1);
    expect_fail("E_SLIPPAGE", || c.leave(U64(id), U128(edge + 1)));
    let s = state(&c, ready);
    assert_eq!(s.total_left.0, 0);
    assert_eq!(s.cap_available.0, room);

    // The quote for the whole exit is a fair limit for a part of it.
    at(&creator(), ready, 1);
    assert_eq!(c.leave(U64(id), U128(quote_whole)).0, room);
    assert_eq!(transfers_out(), quote_room);

    // The next fill is measured against what was left before it.
    let t2 = ready + 6 * MINUTE;
    let left = whole - room;
    let room2 = state(&c, t2).cap_available.0;
    assert!(room2 > 0 && room2 < left);
    let quote2 = c.quote_sell(U128(room2)).0;
    let edge2 = loud_math::mul_div(quote2, left, room2);
    at(&creator(), t2, 1);
    expect_fail("E_SLIPPAGE", || c.leave(U64(id), U128(edge2 + 1)));
    at(&creator(), t2, 1);
    assert_eq!(c.leave(U64(id), U128(edge2)).0, room2);
    assert_eq!(transfers_out(), quote2);
    assert_eq!(c.get_exits(0, 100)[0].remaining.0, left - room2);
}

#[test]
fn leave_keeps_the_plain_price_limit_on_a_full_fill() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    buy(&mut c, &acc("whale.test"), T0 + SECOND_NS, 1_000 * NEAR);
    let amount = 10_000 * E18;
    let id = shout(&mut c, &creator(), T0 + 2 * SECOND_NS, amount);
    let ready = T0 + 2 * SECOND_NS + cfg.notice;
    at(&creator(), ready, 0);
    let quote = c.quote_sell(U128(amount)).0;
    at(&creator(), ready, 1);
    expect_fail("E_SLIPPAGE", || c.leave(U64(id), U128(quote + 1)));
    at(&creator(), ready, 1);
    assert_eq!(c.leave(U64(id), U128(quote)).0, amount);
    assert_eq!(transfers_out(), quote);
    assert!(c.get_exits(0, 100).is_empty());
}

#[test]
fn leave_removes_a_fully_filled_exit() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    buy(&mut c, &acc("whale.test"), T0 + SECOND_NS, 1_000 * NEAR);
    let amount = 10_000 * E18;
    let id = shout(&mut c, &creator(), T0 + 2 * SECOND_NS, amount);
    let ready = T0 + 2 * SECOND_NS + cfg.notice;
    assert_eq!(leave(&mut c, &creator(), ready, id), amount);
    assert!(logged("\"remaining\":\"0\""));
    assert!(c.get_exits(0, 100).is_empty());
    assert!(c.get_account(creator()).exits.is_empty());
    let s = state(&c, ready);
    assert_eq!(s.open_exits, 0);
    assert_eq!(s.escrowed.0, 0);
    assert_eq!(s.total_left.0, amount);
    at(&creator(), ready, 1);
    expect_fail("E_NO_EXIT", || c.leave(U64(id), U128(0)));
}

#[test]
fn leave_needs_near_in_the_pool() {
    // Nobody bought, so the pool holds no real NEAR to pay with.
    let cfg = standard();
    let mut c = deploy(&cfg);
    let id = shout(&mut c, &creator(), T0 + SECOND_NS, 1_000_000 * E18);
    at(&creator(), T0 + SECOND_NS + cfg.notice, 1);
    expect_fail("E_POOL_EMPTY", || c.leave(U64(id), U128(0)));
}

#[test]
fn leave_fills_only_what_the_pool_can_pay() {
    // A small buy: the pool holds 0.01 NEAR, far less than the room is worth.
    let cfg = standard();
    let mut c = deploy(&cfg);
    buy(&mut c, &acc("minnow.test"), T0 + SECOND_NS, NEAR / 100);
    let id = shout(&mut c, &creator(), T0 + 2 * SECOND_NS, 20_000_000 * E18);
    let ready = T0 + 2 * SECOND_NS + cfg.notice;
    let before = state(&c, ready);
    let room = before.cap_available.0;
    let payable = loud_math::max_sell(before.pool_tokens.0, cfg.virtual_near, before.pool_near.0);
    assert!(payable > 0 && payable < room);
    assert!(c.quote_sell(U128(room)).0 > before.pool_near.0);
    let quote = c.quote_sell(U128(payable)).0;
    assert!(quote > 0 && quote <= before.pool_near.0);

    let filled = leave(&mut c, &creator(), ready, id);
    assert_eq!(filled, payable);
    assert_eq!(transfers_out(), quote);
    let s = state(&c, ready);
    assert_eq!(s.pool_near.0, before.pool_near.0 - quote);
    assert_eq!(s.pool_tokens.0, before.pool_tokens.0 + payable);
    // Only the filled units used cap room and left escrow.
    assert_eq!(s.cap_available.0, room - payable);
    assert_eq!(s.escrowed.0, 20_000_000 * E18 - payable);
    assert_eq!(s.total_left.0, payable);
}

#[test]
fn get_exits_pages_past_one_hundred_open_exits() {
    let mut c = deploy(&standard());
    let ts = T0 + SECOND_NS;
    let dust = 1_000 * E18;
    // 13 accounts with 8 open exits each.
    for i in 0..13 {
        let w = acc(&format!("w{i}.test"));
        register(&mut c, &w, ts);
        at(&creator(), ts, 1);
        c.transfer_loud(w.clone(), U128(8 * dust));
        for _ in 0..8 {
            shout(&mut c, &w, ts, dust);
        }
    }
    assert_eq!(state(&c, ts).open_exits, 104);
    let mut ids: Vec<u64> = c.get_exits(0, 1_000).iter().map(|e| e.id.0).collect();
    assert_eq!(ids.len(), 100);
    ids.extend(c.get_exits(100, 100).iter().map(|e| e.id.0));
    assert_eq!(ids, (1..=104).collect::<Vec<u64>>());
    assert!(c.get_exits(104, 100).is_empty());
}

#[test]
fn a_shout_is_binding_until_the_exit_expires() {
    let (mut c, id, ready) = launch_with_shout();
    let t_shout = ready - 30 * MINUTE;
    let expires = ready + 60 * MINUTE;
    let other = acc("whale.test");
    at(&creator(), ready, 0);
    expect_fail("E_YOCTO", || c.hush(U64(id)));
    at(&creator(), ready, 1);
    expect_fail("E_NO_EXIT", || c.hush(U64(42)));

    // Nobody can take the shout back, the owner included: not right after
    // it, not during the notice, not inside the exit window, and not at
    // `expires_at` itself.
    for ts in [t_shout, ready - 1, ready, expires] {
        for who in [creator(), other.clone()] {
            at(&who, ts, 1);
            expect_fail("E_NOTICE_BINDING", || c.hush(U64(id)));
        }
    }
    let s = state(&c, expires);
    assert_eq!(s.escrowed.0, 20_000_000 * E18);
    assert_eq!(s.open_exits, 1);
    assert_eq!(bal(&c, &creator()), (30_000_000 * E18, 0));
    // The message says when the exit can be closed.
    at(&creator(), ready, 1);
    let err = catch_unwind(AssertUnwindSafe(|| c.hush(U64(id)))).unwrap_err();
    let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(msg.contains(&expires.to_string()), "{msg}");

    // One nanosecond later the owner gets the tokens back, still loud.
    let outstanding = s.loud_outstanding.0;
    hush(&mut c, &creator(), expires + 1, id);
    assert!(has_event("hush"));
    assert_eq!(bal(&c, &creator()), (50_000_000 * E18, 0));
    let s = state(&c, expires + 1);
    assert_eq!(s.escrowed.0, 0);
    assert_eq!(s.open_exits, 0);
    assert_eq!(s.loud_outstanding.0, outstanding, "hushed tokens are still loud");
    assert_eq!(s.total_left.0, 0);
}

#[test]
fn statistics_counters_saturate() {
    let (mut c, id, ready) = launch_with_shout();
    // The counters are display only. At their maximum they must not stop
    // a shout or a leave.
    c.total_shouted = u128::MAX;
    c.shout_count = u64::MAX;
    c.total_left = u128::MAX;
    c.leave_count = u64::MAX;
    shout(&mut c, &creator(), ready, 1_000 * E18);
    assert!(leave(&mut c, &creator(), ready, id) > 0);
    let s = state(&c, ready);
    assert_eq!(s.total_shouted.0, u128::MAX);
    assert_eq!(s.shout_count, u64::MAX);
    assert_eq!(s.total_left.0, u128::MAX);
    assert_eq!(s.leave_count, u64::MAX);
}

#[test]
fn anyone_can_hush_an_expired_exit() {
    let (mut c, id, ready) = launch_with_shout();
    let part = leave(&mut c, &creator(), ready, id);
    let expires = ready + 60 * MINUTE;
    hush(&mut c, &acc("passerby.test"), expires + 1, id);
    // The rest goes back to the owner, not to the caller, and stays loud.
    assert_eq!(bal(&c, &creator()), (50_000_000 * E18 - part, 0));
    assert_eq!(bal(&c, &acc("passerby.test")), (0, 0));
    assert_eq!(state(&c, expires + 1).open_exits, 0);
    at(&creator(), expires + 1, 1);
    expect_fail("E_NO_LOUD", || c.shout(U128(50_000_000 * E18)));
}

// NEP-141

/// Alice holds loud (bought in the window) and quiet (bought after it).
fn alice_with_both() -> (Loud, AccountId, u128, u128, u64) {
    let mut c = deploy(&standard());
    let alice = acc("alice.test");
    let loud = buy(&mut c, &alice, T0 + SECOND_NS, 10 * NEAR);
    let ts = T0 + 11 * MINUTE;
    let quiet = buy(&mut c, &alice, ts, 10 * NEAR);
    assert_eq!(bal(&c, &alice), (loud, quiet));
    (c, alice, loud, quiet, ts)
}

#[test]
fn ft_transfer_takes_quiet_first_and_moves_the_tag() {
    let (mut c, alice, loud, quiet, ts) = alice_with_both();
    let bob = acc("bob.test");
    register(&mut c, &bob, ts);
    let outstanding = state(&c, ts).loud_outstanding.0;

    // Less than the quiet balance: only quiet moves, no tag_move event.
    at(&alice, ts, 1);
    c.ft_transfer(bob.clone(), U128(quiet / 4), Some("hello \"bob\"".to_string()));
    assert!(has_event("ft_transfer"));
    assert!(logged("\"old_owner_id\":\"alice.test\""));
    assert!(!has_event("tag_move"));
    assert_eq!(bal(&c, &bob), (0, quiet / 4));
    assert_eq!(bal(&c, &alice), (loud, quiet - quiet / 4));

    // More than the quiet balance: all quiet, then loud for the rest.
    let rest_quiet = quiet - quiet / 4;
    let loud_part = loud / 3;
    at(&alice, ts, 1);
    c.ft_transfer(bob.clone(), U128(rest_quiet + loud_part), None);
    assert!(has_event("tag_move"));
    assert!(logged(&format!("\"loud_amount\":\"{loud_part}\"")));
    assert_eq!(bal(&c, &alice), (loud - loud_part, 0));
    assert_eq!(bal(&c, &bob), (loud_part, quiet));
    assert_eq!(c.ft_balance_of(bob.clone()).0, loud_part + quiet);
    assert_eq!(state(&c, ts).loud_outstanding.0, outstanding);

    // Bob can sell the quiet part only.
    at(&bob, ts, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(quiet + 1), U128(0)));
    sell(&mut c, &bob, ts, quiet);
    assert_eq!(bal(&c, &bob), (loud_part, 0));
}

/// Sum of `ft_balance_of` over `accounts`, read at block time `ts`.
fn ft_sum(c: &Loud, ts: u64, accounts: &[AccountId]) -> u128 {
    at(&token(), ts, 0);
    let mut sum = 0u128;
    for a in accounts.iter() {
        sum += c.ft_balance_of(a.clone()).0;
    }
    sum
}

/// Conservation through the public NEP-141 views: the token account's own
/// balance is the pool inventory plus the escrow, and all balances together
/// equal `ft_total_supply` after every kind of call.
#[test]
fn ft_balances_add_up_to_the_total_supply() {
    let cfg = standard();
    let mut c = deploy(&cfg);
    let early = acc("early.test");
    let late = acc("late.test");
    let friend = acc("friend.test");
    let everyone = [creator(), early.clone(), late.clone(), friend.clone(), token()];
    register(&mut c, &friend, T0);
    let supply = c.ft_total_supply().0;
    assert_eq!(supply, cfg.supply);

    // After `new`: the pool mint is the token account's balance.
    assert_eq!(c.ft_balance_of(token()).0, 950_000_000 * E18);
    assert_eq!(ft_sum(&c, T0, &everyone), supply);

    // A loud buy in the launch window and a quiet buy after it.
    let loud_bought = buy(&mut c, &early, T0 + SECOND_NS, 1_000 * NEAR);
    assert_eq!(c.ft_balance_of(token()).0, 950_000_000 * E18 - loud_bought);
    assert_eq!(ft_sum(&c, T0 + SECOND_NS, &everyone), supply);
    let t1 = T0 + 11 * MINUTE;
    let quiet_bought = buy(&mut c, &late, t1, 10 * NEAR);
    assert_eq!(bal(&c, &late), (0, quiet_bought));
    assert_eq!(ft_sum(&c, t1, &everyone), supply);

    // shout: the escrow counts as the token account's balance.
    let pool_before = state(&c, t1).pool_tokens.0;
    let id = shout(&mut c, &creator(), t1, 20_000_000 * E18);
    assert_eq!(c.ft_balance_of(creator()).0, 30_000_000 * E18);
    assert_eq!(c.ft_balance_of(token()).0, pool_before + 20_000_000 * E18);
    assert_eq!(ft_sum(&c, t1, &everyone), supply);

    // Transfers between accounts, loud and quiet.
    at(&late, t1, 1);
    c.ft_transfer(friend.clone(), U128(quiet_bought / 4), None);
    at(&creator(), t1, 1);
    c.transfer_loud(friend.clone(), U128(1_000_000 * E18));
    assert_eq!(c.ft_balance_of(friend.clone()).0, quiet_bought / 4 + 1_000_000 * E18);
    assert_eq!(ft_sum(&c, t1, &everyone), supply);

    // A transfer to the token account itself is refused, quiet or loud, so
    // its balance stays the pool inventory plus the escrow.
    at(&late, t1, 1);
    expect_fail("E_RECEIVER", || c.ft_transfer(token(), U128(quiet_bought / 4), None));
    at(&creator(), t1, 1);
    expect_fail("E_RECEIVER", || c.ft_transfer(token(), U128(E18), None));
    at(&creator(), t1, 1);
    expect_fail("E_RECEIVER", || c.transfer_loud(token(), U128(E18)));
    at(&late, t1, 1);
    expect_fail("E_RECEIVER", || {
        c.ft_transfer_call(token(), U128(quiet_bought / 4), None, String::new()).detach()
    });
    assert_eq!(bal(&c, &token()), (0, 0));
    assert_eq!(bal(&c, &late), (0, quiet_bought - quiet_bought / 4));
    let s = state(&c, t1);
    assert_eq!(c.ft_balance_of(token()).0, s.pool_tokens.0 + s.escrowed.0);
    assert_eq!(ft_sum(&c, t1, &everyone), supply);

    // Partial leave: the cap has room for less than the exit.
    let ready = t1 + cfg.notice;
    let filled = leave(&mut c, &creator(), ready, id);
    assert!(filled > 0 && filled < 20_000_000 * E18, "filled {filled}");
    let s = state(&c, ready);
    assert_eq!(s.escrowed.0, 20_000_000 * E18 - filled);
    assert_eq!(c.ft_balance_of(token()).0, s.pool_tokens.0 + s.escrowed.0);
    assert_eq!(ft_sum(&c, ready, &everyone), supply);

    // hush after expiry: the rest of the escrow goes back to the owner.
    let expired = ready + cfg.exit_window + 1;
    hush(&mut c, &creator(), expired, id);
    let s = state(&c, expired);
    assert_eq!(s.escrowed.0, 0);
    assert_eq!(c.ft_balance_of(creator()).0, 49_000_000 * E18 - filled);
    assert_eq!(c.ft_balance_of(token()).0, s.pool_tokens.0);
    assert_eq!(ft_sum(&c, expired, &everyone), supply);

    // A quiet sell returns the tokens to the pool.
    let rest = quiet_bought - quiet_bought / 4;
    assert_eq!(bal(&c, &late), (0, rest));
    sell(&mut c, &late, expired, rest);
    assert_eq!(c.ft_balance_of(late.clone()).0, 0);
    assert_eq!(ft_sum(&c, expired, &everyone), supply);
    let s = state(&c, expired);
    assert_eq!(c.ft_balance_of(token()).0, s.pool_tokens.0);
}

#[test]
fn transfers_need_a_registered_receiver() {
    let (mut c, alice, loud, quiet, ts) = alice_with_both();
    let bob = acc("bob.test");
    assert!(!c.is_registered(bob.clone()));
    at(&alice, ts, 1);
    expect_fail("E_UNREGISTERED", || c.ft_transfer(bob.clone(), U128(1), None));
    at(&alice, ts, 1);
    expect_fail("E_UNREGISTERED", || c.transfer_loud(bob.clone(), U128(1)));
    at(&alice, ts, 1);
    expect_fail("E_UNREGISTERED", || {
        c.ft_transfer_call(bob.clone(), U128(1), None, String::new()).detach()
    });
    assert_eq!(bal(&c, &alice), (loud, quiet));
    assert_eq!(bal(&c, &bob), (0, 0));

    // Alice pays the fee for bob, and then all three go through.
    at(&alice, ts, STORAGE_FEE);
    c.storage_deposit(Some(bob.clone()), None);
    assert!(c.is_registered(bob.clone()));
    at(&alice, ts, 1);
    c.ft_transfer(bob.clone(), U128(3), None);
    at(&alice, ts, 1);
    c.transfer_loud(bob.clone(), U128(5));
    at(&alice, ts, 1);
    c.ft_transfer_call(bob.clone(), U128(7), None, String::new()).detach();
    assert_eq!(bal(&c, &bob), (5, 10));
    assert_eq!(bal(&c, &alice), (loud - 5, quiet - 10));
}

#[test]
fn ft_transfer_checks() {
    let (mut c, alice, loud, quiet, ts) = alice_with_both();
    let bob = acc("bob.test");
    register(&mut c, &bob, ts);
    at(&alice, ts, 0);
    expect_fail("E_YOCTO", || c.ft_transfer(bob.clone(), U128(1), None));
    at(&alice, ts, 1);
    expect_fail("E_BALANCE", || c.ft_transfer(bob.clone(), U128(loud + quiet + 1), None));
    at(&alice, ts, 1);
    expect_fail("E_AMOUNT", || c.ft_transfer(bob.clone(), U128(0), None));
    at(&alice, ts, 1);
    expect_fail("E_SELF", || c.ft_transfer(alice.clone(), U128(1), None));
    at(&alice, ts, 1);
    expect_fail("E_RECEIVER", || c.ft_transfer(token(), U128(1), None));
    assert_eq!(bal(&c, &alice), (loud, quiet));
    at(&bob, ts, 1);
    expect_fail("E_BALANCE", || c.ft_transfer(alice.clone(), U128(1), None));
    // The whole balance can move.
    at(&alice, ts, 1);
    c.ft_transfer(bob.clone(), U128(loud + quiet), None);
    assert_eq!(bal(&c, &alice), (0, 0));
    assert_eq!(bal(&c, &bob), (loud, quiet));
}

#[test]
fn tag_follows_the_tokens() {
    // SPEC 8.2: a fresh account that receives loud tokens holds loud tokens.
    let mut c = deploy(&standard());
    let fresh = acc("fresh.test");
    let ts = T0 + 600 * MINUTE;
    register(&mut c, &fresh, ts);
    at(&creator(), ts, 1);
    c.transfer_loud(fresh.clone(), U128(1_000_000 * E18));
    assert!(has_event("tag_move"));
    assert!(has_event("ft_transfer"));
    assert_eq!(bal(&c, &fresh), (1_000_000 * E18, 0));
    assert_eq!(bal(&c, &creator()), (49_000_000 * E18, 0));
    at(&fresh, ts, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(1_000_000 * E18), U128(0)));
    // Plain ft_transfer of loud tokens carries the tag the same way.
    let second = acc("second.test");
    register(&mut c, &second, ts);
    at(&fresh, ts, 1);
    c.ft_transfer(second.clone(), U128(400_000 * E18), None);
    assert_eq!(bal(&c, &second), (400_000 * E18, 0));
    at(&second, ts, 1);
    expect_fail("E_NO_QUIET", || c.sell(U128(E18), U128(0)));
    // The door still works for the receiver.
    assert_eq!(shout(&mut c, &second, ts, 400_000 * E18), 1);
}

#[test]
fn transfer_loud_checks() {
    let (mut c, alice, loud, _quiet, ts) = alice_with_both();
    let bob = acc("bob.test");
    register(&mut c, &bob, ts);
    at(&alice, ts, 0);
    expect_fail("E_YOCTO", || c.transfer_loud(bob.clone(), U128(1)));
    at(&alice, ts, 1);
    expect_fail("E_NO_LOUD", || c.transfer_loud(bob.clone(), U128(loud + 1)));
    at(&alice, ts, 1);
    expect_fail("E_NO_LOUD", || c.transfer_loud(bob.clone(), U128(0)));
    at(&alice, ts, 1);
    expect_fail("E_SELF", || c.transfer_loud(alice.clone(), U128(1)));
    at(&alice, ts, 1);
    expect_fail("E_RECEIVER", || c.transfer_loud(token(), U128(1)));
    assert_eq!(bal(&c, &alice).0, loud);
    // Quiet is not touched by transfer_loud.
    at(&alice, ts, 1);
    c.transfer_loud(bob.clone(), U128(loud));
    assert_eq!(bal(&c, &alice).0, 0);
    assert_eq!(bal(&c, &bob), (loud, 0));
}

#[test]
fn ft_transfer_call_rejects_loud() {
    let (mut c, alice, loud, quiet, ts) = alice_with_both();
    let dex = acc("dex.test");
    register(&mut c, &dex, ts);
    at(&alice, ts, 0);
    expect_fail("E_YOCTO", || c.ft_transfer_call(dex.clone(), U128(1), None, String::new()).detach());
    at(&alice, ts, 1);
    expect_fail("E_QUIET_DOOR", || {
        c.ft_transfer_call(dex.clone(), U128(quiet + 1), None, String::new()).detach()
    });
    at(&alice, ts, 1);
    expect_fail("E_QUIET_DOOR", || {
        c.ft_transfer_call(dex.clone(), U128(quiet + loud), None, String::new()).detach()
    });
    at(&alice, ts, 1);
    expect_fail("E_QUIET_DOOR", || {
        c.ft_transfer_call(dex.clone(), U128(quiet + loud + 1), None, String::new()).detach()
    });
    at(&alice, ts, 1);
    expect_fail("E_AMOUNT", || c.ft_transfer_call(dex.clone(), U128(0), None, String::new()).detach());
    at(&alice, ts, 1);
    expect_fail("E_SELF", || c.ft_transfer_call(alice.clone(), U128(1), None, String::new()).detach());
    at(&alice, ts, 1);
    expect_fail("E_RECEIVER", || c.ft_transfer_call(token(), U128(1), None, String::new()).detach());
    // A loud-only holder cannot use it at all.
    at(&creator(), ts, 1);
    expect_fail("E_QUIET_DOOR", || {
        c.ft_transfer_call(dex.clone(), U128(E18), None, String::new()).detach()
    });
    // Nothing moved.
    assert_eq!(bal(&c, &alice), (loud, quiet));
    assert_eq!(bal(&c, &dex), (0, 0));
}

#[test]
fn storage_deposit_registers_once_and_refunds_the_rest() {
    let mut c = deploy(&standard());
    assert_eq!(STORAGE_MIN_YOCTO, STORAGE_FEE);
    let bounds = c.storage_balance_bounds();
    assert_eq!(bounds.min.0, STORAGE_FEE);
    assert_eq!(bounds.max, Some(U128(STORAGE_FEE)));
    let alice = acc("alice.test");
    let bob = acc("bob.test");
    assert!(c.storage_balance_of(alice.clone()).is_none());
    assert!(!c.is_registered(alice.clone()));

    // Less than the fee: nothing is kept and nobody is registered.
    at(&alice, T0 + 1, STORAGE_FEE - 1);
    expect_fail("E_STORAGE", || c.storage_deposit(None, None));
    at(&alice, T0 + 1, 0);
    expect_fail("E_STORAGE", || c.storage_deposit(Some(bob.clone()), None));
    assert!(!c.is_registered(alice.clone()));
    assert!(!c.is_registered(bob.clone()));

    // The exact fee registers the caller and leaves nothing to refund.
    at(&alice, T0 + 1, STORAGE_FEE);
    let b = c.storage_deposit(None, None);
    assert_eq!((b.total.0, b.available.0), (STORAGE_FEE, 0));
    assert_eq!(transfers_out(), 0);
    assert!(c.is_registered(alice.clone()));
    let b = c.storage_balance_of(alice.clone()).unwrap();
    assert_eq!((b.total.0, b.available.0), (STORAGE_FEE, 0));

    // Alice registers bob with too much attached: the fee is kept and the
    // rest goes back to alice, who paid.
    at(&alice, T0 + 2, STORAGE_FEE + 7 * NEAR);
    let b = c.storage_deposit(Some(bob.clone()), Some(true));
    assert_eq!((b.total.0, b.available.0), (STORAGE_FEE, 0));
    assert_eq!(transfers_out(), 7 * NEAR);
    assert_eq!(paid_to(&alice), 7 * NEAR);
    assert!(calls_out().contains(&(token(), "on_payout".to_string())));
    assert!(c.is_registered(bob.clone()));

    // Already registered: the whole deposit goes back, whoever sends it.
    at(&bob, T0 + 3, STORAGE_FEE);
    c.storage_deposit(None, None);
    assert_eq!(paid_to(&bob), STORAGE_FEE);
    at(&alice, T0 + 3, 5);
    c.storage_deposit(Some(bob.clone()), None);
    assert_eq!(paid_to(&alice), 5);
    at(&acc("carol.test"), T0 + 3, NEAR);
    c.storage_deposit(Some(creator()), None);
    assert_eq!(paid_to(&acc("carol.test")), NEAR);
    assert!(!c.is_registered(acc("carol.test")));

    // Fees are not pool liquidity.
    assert_eq!(state(&c, T0 + 3).pool_near.0, 0);
}

// Invariants of SPEC 4 under a random operation sequence

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform enough for tests: a value in `0..n`. `n` must be > 0.
    fn below(&mut self, n: u128) -> u128 {
        let v = ((self.next_u64() as u128) << 64) | self.next_u64() as u128;
        v % n
    }
}

#[test]
fn invariants_hold_over_random_operations() {
    let cfg = demo();
    let mut c = deploy(&cfg);
    let p = c.get_params();
    let cap = p.cap_units.0;
    let loud_until = p.loud_until.0;
    let dust = cfg.supply / 1_000_000;

    let mut users = vec![creator()];
    for i in 0..6 {
        users.push(acc(&format!("user{i}.test")));
    }

    let mut rng = Rng(0x10AD_10AD_5EED_0001);
    let mut now = T0;
    // NEAR the contract account received minus NEAR it sent (invariant 5).
    let mut balance: u128 = 0;
    // Storage fees the contract kept. They are in `balance` and must never
    // be counted as pool liquidity.
    let mut fees: u128 = 0;
    // Two users register up front and can receive tokens before they buy.
    // The others register with their first buy.
    for u in users[1..3].iter() {
        register(&mut c, u, now);
        balance += STORAGE_FEE;
        fees += STORAGE_FEE;
    }
    let mut prev_outstanding = state(&c, now).loud_outstanding.0;
    // (time, total_left, cap_available) right after a state-changing call.
    let mut snaps: Vec<(u64, u128, u128)> = vec![(T0, 0, 0)];
    let mut done = [0u32; 7];
    let mut loud_buys = 0u32;

    for step in 0..2_500u32 {
        // Short steps first, so many calls land inside the loud window.
        let max_step = if step < 100 { SECOND_NS } else { 40 * SECOND_NS };
        now += rng.below(max_step as u128) as u64;
        let who = users[rng.below(users.len() as u128) as usize].clone();
        let other = users[rng.below(users.len() as u128) as usize].clone();
        let (loud, quiet) = bal(&c, &who);
        let mut touched = false;

        match rng.below(7) {
            0 => {
                let near = NEAR / 100 + rng.below(30 * NEAR);
                let fee = if c.is_registered(who.clone()) { 0 } else { STORAGE_FEE };
                buy(&mut c, &who, now, near);
                assert!(c.is_registered(who.clone()));
                balance += near + fee;
                fees += fee;
                if now < loud_until {
                    loud_buys += 1;
                }
                touched = true;
                done[0] += 1;
            }
            1 => {
                if quiet > 0 {
                    let amount = 1 + rng.below(quiet);
                    at(&token(), now, 0);
                    let quote = c.quote_sell(U128(amount)).0;
                    if quote > 0 && quote <= c.get_state().pool_near.0 {
                        let near_out = sell(&mut c, &who, now, amount);
                        assert_eq!(transfers_out(), near_out);
                        balance = balance + 1 - near_out;
                        touched = true;
                        done[1] += 1;
                    }
                }
            }
            2 => {
                if loud >= dust && c.get_account(who.clone()).exits.len() < 8 {
                    let amount = dust + rng.below(loud - dust + 1);
                    shout(&mut c, &who, now, amount);
                    balance += 1;
                    touched = true;
                    done[2] += 1;
                }
            }
            3 => {
                // Any exit that is inside its window; its owner leaves.
                at(&token(), now, 0);
                let ready: Vec<Exit> = c
                    .get_exits(0, 100)
                    .into_iter()
                    .filter(|e| e.ready_at.0 <= now && now <= e.expires_at.0)
                    .collect();
                if !ready.is_empty() {
                    let e = ready[rng.below(ready.len() as u128) as usize].clone();
                    let s = c.get_state();
                    let fill = core::cmp::min(e.remaining.0, s.cap_available.0);
                    let quote = c.quote_sell(U128(fill)).0;
                    if fill > 0 && quote > 0 && quote <= s.pool_near.0 {
                        let filled = leave(&mut c, &e.owner, now, e.id.0);
                        assert_eq!(filled, fill);
                        assert_eq!(transfers_out(), quote);
                        balance = balance + 1 - quote;
                        touched = true;
                        done[3] += 1;
                    }
                }
            }
            4 => {
                // A shout is binding, so only an expired exit can be
                // hushed. Any account may do it.
                at(&token(), now, 0);
                let all = c.get_exits(0, 100);
                if let Some(e) = all.iter().find(|e| now > e.expires_at.0) {
                    hush(&mut c, &other, now, e.id.0);
                    balance += 1;
                    touched = true;
                    done[4] += 1;
                }
            }
            5 => {
                if loud + quiet > 0 && other != who && c.is_registered(other.clone()) {
                    let amount = 1 + rng.below(loud + quiet);
                    at(&who, now, 1);
                    c.ft_transfer(other.clone(), U128(amount), None);
                    balance += 1;
                    touched = true;
                    done[5] += 1;
                }
            }
            _ => {
                if loud > 0 && other != who && c.is_registered(other.clone()) {
                    let amount = 1 + rng.below(loud);
                    at(&who, now, 1);
                    c.transfer_loud(other.clone(), U128(amount));
                    balance += 1;
                    touched = true;
                    done[6] += 1;
                }
            }
        }

        // Invariants
        let s = state(&c, now);
        let mut sum_loud = 0u128;
        let mut sum_quiet = 0u128;
        for u in users.iter() {
            let (l, q) = bal(&c, u);
            sum_loud += l;
            sum_quiet += q;
        }
        let exits = c.get_exits(0, 100);
        let open: u128 = exits.iter().map(|e| e.remaining.0).sum();
        assert_eq!(exits.len() as u32, s.open_exits, "step {step}");
        assert_eq!(open, s.escrowed.0, "step {step}: escrow matches open exits");
        // 1
        assert_eq!(
            s.pool_tokens.0 + sum_loud + sum_quiet + s.escrowed.0,
            cfg.supply,
            "step {step}: supply is conserved"
        );
        // 2
        assert_eq!(s.loud_outstanding.0, sum_loud + s.escrowed.0, "step {step}");
        // 3
        if now >= loud_until {
            assert!(s.loud_outstanding.0 <= prev_outstanding, "step {step}: loud supply grew");
        }
        prev_outstanding = s.loud_outstanding.0;
        // 4
        assert!(s.cap_available.0 <= cap);
        for (t0, left0, room0) in snaps.iter() {
            let bound = room0 + loud_math::mul_div(cap, (now - t0) as u128, cfg.cap_window as u128);
            assert!(
                s.total_left.0 - left0 <= bound,
                "step {step}: {} units left since {t0}, bound {bound}",
                s.total_left.0 - left0
            );
        }
        if touched && snaps.len() < 60 && step % 20 == 0 {
            snaps.push((now, s.total_left.0, s.cap_available.0));
        }
        // 5
        assert!(balance >= s.pool_near.0 + fees, "step {step}: pool_near is not covered");
        // Tokens are only ever held by registered accounts.
        for u in users.iter() {
            let (l, q) = bal(&c, u);
            assert!(l + q == 0 || c.is_registered(u.clone()), "step {step}: {u} holds tokens unregistered");
        }
    }

    let s = state(&c, now);
    assert!(s.total_shouted.0 >= s.total_left.0);
    assert_eq!(s.shout_count as u32, done[2]);
    assert_eq!(s.leave_count as u32, done[3]);
    // Every kind of operation ran many times, and time passed the windows.
    for (i, n) in done.iter().enumerate() {
        assert!(*n >= 20, "operation {i} ran only {n} times");
    }
    assert!(snaps.len() > 20);
    assert!(loud_buys >= 5, "only {loud_buys} buys inside the loud window");
    assert_eq!(fees, users.len() as u128 * STORAGE_FEE - STORAGE_FEE, "everyone but the creator paid once");
    assert!(now > loud_until + 10 * cfg.cap_window);
    assert!(s.total_left.0 > cap, "more than one full cap left over the run");
}

// SPEC 8.1: the split test

struct SplitRun {
    /// Cumulative loud units sold after each checkpoint.
    sold: Vec<u128>,
    bucket_at_ready: u128,
    cap_units: u128,
    held: u128,
}

const SPLIT_STEPS: u64 = 20;

/// The creator allocation is split across `wallets` accounts (1 = no
/// split). Everyone shouts at the same time and leaves as fast as the
/// contract allows, at the same block times in every run.
fn run_split(wallets: usize) -> SplitRun {
    let cfg = standard();
    let mut c = deploy(&cfg);
    // Same pool history in every run, so the pool can pay.
    buy(&mut c, &acc("whale.test"), T0 + SECOND_NS, 2_000 * NEAR);
    let held = c.get_params().creator_alloc.0;
    let cap_units = c.get_params().cap_units.0;
    let t_shout = T0 + 2 * SECOND_NS;

    let mut owners: Vec<(AccountId, u64)> = Vec::new();
    if wallets == 1 {
        let id = shout(&mut c, &creator(), t_shout, held);
        owners.push((creator(), id));
    } else {
        let share = held / wallets as u128;
        let mut parts: Vec<(AccountId, u128)> = Vec::new();
        for i in 0..wallets {
            let w = acc(&format!("w{i}.test"));
            let amount = if i + 1 == wallets { held - share * (wallets as u128 - 1) } else { share };
            register(&mut c, &w, t_shout);
            at(&creator(), t_shout, 1);
            c.transfer_loud(w.clone(), U128(amount));
            parts.push((w, amount));
        }
        assert_eq!(bal(&c, &creator()), (0, 0));
        for (w, amount) in parts {
            // SPEC 8.2: every receiving wallet holds loud tokens only.
            assert_eq!(bal(&c, &w), (amount, 0));
            let id = shout(&mut c, &w, t_shout, amount);
            owners.push((w, id));
        }
    }

    let ready = t_shout + cfg.notice;
    let bucket_at_ready = state(&c, ready).cap_available.0;
    let mut sold = Vec::new();
    let mut next = 0usize;
    for k in 0..=SPLIT_STEPS {
        let ts = ready + cfg.cap_window / SPLIT_STEPS * k;
        while next < owners.len() {
            if state(&c, ts).cap_available.0 == 0 {
                break;
            }
            let (who, id) = owners[next].clone();
            let remaining = c.get_account(who.clone()).exits[0].remaining.0;
            let filled = leave(&mut c, &who, ts, id);
            if filled == remaining {
                next += 1;
            }
        }
        sold.push(state(&c, ts).total_left.0);
    }
    SplitRun { sold, bucket_at_ready, cap_units, held }
}

#[test]
fn split_test_one_wallet_vs_one_hundred() {
    const N: usize = 100;
    // Separate threads: each run gets its own mocked chain.
    let one = std::thread::spawn(|| run_split(1)).join().unwrap();
    let many = std::thread::spawn(|| run_split(N)).join().unwrap();

    let cfg = standard();
    let tokens = |units: u128| units / E18;
    println!();
    println!("SPLIT TEST (SPEC 8.1), standard preset");
    println!(
        "held {} LOUD loud, cap {} LOUD per {} min, room at the end of notice {} LOUD",
        tokens(one.held),
        tokens(one.cap_units),
        cfg.cap_window / MINUTE,
        tokens(one.bucket_at_ready)
    );
    println!("{:>18} | {:>18} | {:>18} | {:>10}", "min after notice", "1 wallet, LOUD", "100 wallets, LOUD", "diff units");
    for k in [0u64, 5, 10, 15, 20] {
        let a = one.sold[k as usize];
        let b = many.sold[k as usize];
        println!(
            "{:>18} | {:>18} | {:>18} | {:>10}",
            cfg.cap_window / MINUTE * k / SPLIT_STEPS,
            tokens(a),
            tokens(b),
            a.abs_diff(b)
        );
    }
    println!(
        "minute 0 is the room that built up before the notice ended ({} LOUD, at most one cap).",
        tokens(one.bucket_at_ready)
    );
    println!(
        "new room in the 60 min after that: 1 wallet {} LOUD, 100 wallets {} LOUD, cap {} LOUD.",
        tokens(one.sold[SPLIT_STEPS as usize] - one.sold[0]),
        tokens(many.sold[SPLIT_STEPS as usize] - many.sold[0]),
        tokens(one.cap_units)
    );
    println!(
        "total in the window: {} LOUD <= room at the start + one cap = {} LOUD (SPEC 4, invariant 4).",
        tokens(one.sold[SPLIT_STEPS as usize]),
        tokens(one.bucket_at_ready + one.cap_units)
    );

    assert_eq!(one.cap_units, many.cap_units);
    assert_eq!(one.bucket_at_ready, many.bucket_at_ready);
    // Same amount at every checkpoint, within one unit per account.
    for k in 0..=SPLIT_STEPS as usize {
        assert!(
            one.sold[k].abs_diff(many.sold[k]) <= N as u128,
            "checkpoint {k}: 1 wallet sold {}, {N} wallets sold {}",
            one.sold[k],
            many.sold[k]
        );
    }
    for run in [&one, &many] {
        let last = run.sold[SPLIT_STEPS as usize];
        // The burst at the end of notice is whatever the bucket held.
        assert_eq!(run.sold[0], run.bucket_at_ready);
        assert!(run.sold[0] <= run.cap_units);
        // During the following cap window at most one cap of new room.
        assert!(last - run.sold[0] <= run.cap_units);
        // Invariant 4 over [ready, ready + cap_window].
        assert!(last <= run.bucket_at_ready + run.cap_units);
        // The cap was the limit, not the holding.
        assert!(last < run.held);
        // Sales never go backwards.
        assert!(run.sold.windows(2).all(|w| w[0] <= w[1]));
    }
}

// Failed payouts: on_payout, claim, get_owed

/// Dave buys quiet after the window and sells all of it. Returns the
/// contract, dave, the NEAR paid out and the time.
fn dave_sold() -> (Loud, AccountId, u128, u64) {
    let mut c = deploy(&standard());
    let dave = acc("dave.test");
    let ts = T0 + 11 * MINUTE;
    let out = buy(&mut c, &dave, ts, 20 * NEAR);
    let near_out = sell(&mut c, &dave, ts, out);
    assert!(near_out > 0);
    (c, dave, near_out, ts)
}

#[test]
fn sell_schedules_the_payout_callback() {
    let (c, _dave, near_out, ts) = dave_sold();
    assert_eq!(transfers_out(), near_out);
    assert!(calls_out().contains(&(token(), "on_payout".to_string())));
    assert_eq!(state(&c, ts).owed_total.0, 0);
}

#[test]
fn failed_payout_is_recorded_as_owed() {
    let (mut c, dave, near_out, ts) = dave_sold();
    let pool_near = state(&c, ts).pool_near.0;

    at_callback(ts, PromiseResult::Failed);
    c.on_payout(dave.clone(), U128(near_out));
    assert!(has_event("payout_failed"));
    assert_eq!(transfers_out(), 0);
    assert_eq!(c.get_owed(dave.clone()).0, near_out);
    let s = state(&c, ts);
    assert_eq!(s.owed_total.0, near_out);
    // Owed NEAR is outside pool_near.
    assert_eq!(s.pool_near.0, pool_near);

    // A second failed payout adds to the entry.
    at_callback(ts, PromiseResult::Failed);
    c.on_payout(dave.clone(), U128(7));
    assert_eq!(c.get_owed(dave.clone()).0, near_out + 7);
    assert_eq!(state(&c, ts).owed_total.0, near_out + 7);
    assert_eq!(c.get_owed(acc("erin.test")).0, 0);
}

#[test]
fn successful_payout_records_nothing() {
    let (mut c, dave, near_out, ts) = dave_sold();
    at_callback(ts, PromiseResult::Successful(Vec::new()));
    c.on_payout(dave.clone(), U128(near_out));
    assert!(!has_event("payout_failed"));
    assert_eq!(c.get_owed(dave.clone()).0, 0);
    assert_eq!(state(&c, ts).owed_total.0, 0);
}

#[test]
fn on_payout_is_private() {
    let (mut c, dave, near_out, ts) = dave_sold();
    at(&dave, ts, 0);
    expect_fail("E_PRIVATE", || c.on_payout(dave.clone(), U128(near_out)));
    assert_eq!(c.get_owed(dave.clone()).0, 0);
    assert_eq!(state(&c, ts).owed_total.0, 0);
}

#[test]
fn claim_pays_and_clears_the_debt() {
    let (mut c, dave, near_out, ts) = dave_sold();
    at_callback(ts, PromiseResult::Failed);
    c.on_payout(dave.clone(), U128(near_out));
    let pool_near = state(&c, ts).pool_near.0;

    at(&dave, ts + 1, 0);
    expect_fail("E_YOCTO", || c.claim());
    at(&dave, ts + 1, 1);
    assert_eq!(c.claim().0, near_out);
    assert_eq!(transfers_out(), near_out);
    assert!(calls_out().contains(&(token(), "on_payout".to_string())));
    assert!(has_event("claim"));
    assert_eq!(c.get_owed(dave.clone()).0, 0);
    let s = state(&c, ts + 1);
    assert_eq!(s.owed_total.0, 0);
    assert_eq!(s.pool_near.0, pool_near);

    // The debt is gone, so a second claim fails.
    at(&dave, ts + 2, 1);
    expect_fail("E_NOTHING_OWED", || c.claim());

    // If the claim transfer fails as well, the debt is recorded again.
    at_callback(ts + 2, PromiseResult::Failed);
    c.on_payout(dave.clone(), U128(near_out));
    assert_eq!(c.get_owed(dave.clone()).0, near_out);
    assert_eq!(state(&c, ts + 2).owed_total.0, near_out);
}

#[test]
fn claim_with_nothing_owed_fails() {
    let (mut c, dave, _near_out, ts) = dave_sold();
    at(&dave, ts, 1);
    expect_fail("E_NOTHING_OWED", || c.claim());
    assert_eq!(transfers_out(), 0);
}

// ft_transfer_call and ft_resolve_transfer

/// Alice sends all her quiet tokens to `dex.test` with ft_transfer_call.
fn alice_called_dex() -> (Loud, AccountId, AccountId, u128, u128, u64) {
    let (mut c, alice, loud, quiet, ts) = alice_with_both();
    let dex = acc("dex.test");
    register(&mut c, &dex, ts);
    at(&alice, ts, 1);
    c.ft_transfer_call(dex.clone(), U128(quiet), None, "hello".to_string()).detach();
    let calls = calls_out();
    assert!(calls.contains(&(dex.clone(), "ft_on_transfer".to_string())));
    assert!(calls.contains(&(token(), "ft_resolve_transfer".to_string())));
    assert_eq!(bal(&c, &alice), (loud, 0));
    assert_eq!(bal(&c, &dex), (0, quiet));
    (c, alice, dex, loud, quiet, ts)
}

#[test]
fn ft_transfer_call_keeps_what_the_receiver_used() {
    let (mut c, alice, dex, loud, quiet, ts) = alice_called_dex();
    at_callback(ts, PromiseResult::Successful(b"\"0\"".to_vec()));
    let used = c.ft_resolve_transfer(alice.clone(), dex.clone(), U128(quiet)).0;
    assert_eq!(used, quiet);
    assert!(!logged("\"memo\":\"refund\""));
    assert_eq!(bal(&c, &alice), (loud, 0));
    assert_eq!(bal(&c, &dex), (0, quiet));
}

#[test]
fn ft_transfer_call_refunds_the_unused_part_as_quiet() {
    let (mut c, alice, dex, loud, quiet, ts) = alice_called_dex();
    let unused = 40 * E18;
    assert!(quiet > unused);
    at_callback(ts, PromiseResult::Successful(format!("\"{unused}\"").into_bytes()));
    let used = c.ft_resolve_transfer(alice.clone(), dex.clone(), U128(quiet)).0;
    assert_eq!(used, quiet - unused);
    assert!(logged("\"memo\":\"refund\""));
    assert_eq!(bal(&c, &alice), (loud, unused));
    assert_eq!(bal(&c, &dex), (0, quiet - unused));
}

#[test]
fn ft_transfer_call_refunds_everything_when_the_receiver_fails() {
    let (mut c, alice, dex, loud, quiet, ts) = alice_called_dex();
    at_callback(ts, PromiseResult::Failed);
    let used = c.ft_resolve_transfer(alice.clone(), dex.clone(), U128(quiet)).0;
    assert_eq!(used, 0);
    assert!(logged("\"memo\":\"refund\""));
    assert_eq!(bal(&c, &alice), (loud, quiet));
    assert_eq!(bal(&c, &dex), (0, 0));
}

#[test]
fn ft_transfer_call_refunds_everything_on_an_unreadable_result() {
    let (mut c, alice, dex, loud, quiet, ts) = alice_called_dex();
    at_callback(ts, PromiseResult::Successful(b"not json".to_vec()));
    let used = c.ft_resolve_transfer(alice.clone(), dex.clone(), U128(quiet)).0;
    assert_eq!(used, 0);
    assert_eq!(bal(&c, &alice), (loud, quiet));
    assert_eq!(bal(&c, &dex), (0, 0));
}

#[test]
fn ft_resolve_transfer_only_refunds_what_the_receiver_still_holds() {
    let (mut c, alice, dex, loud, quiet, ts) = alice_called_dex();
    // The receiver moved part of the tokens on before the callback ran.
    let moved = 10 * E18;
    register(&mut c, &acc("erin.test"), ts);
    at(&dex, ts, 1);
    c.ft_transfer(acc("erin.test"), U128(moved), None);
    at_callback(ts, PromiseResult::Failed);
    let used = c.ft_resolve_transfer(alice.clone(), dex.clone(), U128(quiet)).0;
    assert_eq!(used, moved);
    assert_eq!(bal(&c, &alice), (loud, quiet - moved));
    assert_eq!(bal(&c, &dex), (0, 0));
}
