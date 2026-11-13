//! LOUD token contract. The rules are in SPEC.md at the repository root;
//! section numbers in comments refer to that file.
//!
//! Each account has two balances, `loud` and `quiet`. Loud tokens can only
//! reach the pool through `shout` -> notice -> `leave`, and all leaves share
//! one global cap bucket. There is no owner and no setter.
//!
//! Every account pays for its own storage once, when it registers
//! (`storage_deposit`, or the first `buy`). Only a registered account can
//! receive tokens.

#![allow(clippy::too_many_arguments)]

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

#[cfg(test)]
mod tests;

const BPS: u128 = 10_000;
const MIN_SUPPLY: u128 = 10u128.pow(24);
const MAX_SUPPLY: u128 = 10u128.pow(30);
const MAX_CREATOR_BPS: u16 = 2_000;
const MIN_VIRTUAL_NEAR: u128 = 10u128.pow(23);
const MAX_VIRTUAL_NEAR: u128 = 10u128.pow(30);
const MAX_CAP_BPS: u16 = 1_000;
const SECOND_NS: u64 = 1_000_000_000;
const SEVEN_DAYS_NS: u64 = 7 * 24 * 3_600 * SECOND_NS;
const MIN_LOUD_WINDOW_NS: u64 = 60 * SECOND_NS;
const MIN_NOTICE_NS: u64 = 30 * SECOND_NS;
const MIN_EXIT_WINDOW_NS: u64 = 60 * SECOND_NS;
const MIN_CAP_WINDOW_NS: u64 = 60 * SECOND_NS;
/// Smallest buy: 0.001 NEAR.
const MIN_BUY_YOCTO: u128 = 10u128.pow(21);
/// A shout must be at least `total_supply / DUST_DIVISOR`.
const DUST_DIVISOR: u128 = 1_000_000;
const MAX_EXITS_PER_ACCOUNT: usize = 8;
const MAX_EXITS_PAGE: u32 = 100;
/// One-time storage fee per account: 0.02 NEAR, which pays for 2,000 bytes
/// at 10^19 yoctoNEAR per byte. It is kept for good; there is no
/// unregister.
///
/// Bytes one account can occupy. `L` is the length of its id (at most 64),
/// a stored id takes `4 + L`, and every record carries 40 bytes of protocol
/// overhead on top of its key and value:
///
/// ```text
/// loud, quiet, owed       3 * (61 + L)   key 1 + 4 + L, value 16
/// registration            45 + L         key 1 + 4 + L, no value
/// list of open exit ids   49 + L + 8n    key 1 + 4 + L, value 4 + 8n
/// each open exit          198 + L        index record: key 6, value 8;
///                                        exit record: key 32, value 72 + L
/// total                   277 + 5L + n * (206 + L)
/// ```
///
/// With the longest id that is 597 bytes plus 270 per open exit: 1,947
/// bytes with five open exits, so the fee covers the account and five
/// exits. The full eight exits take 2,757 bytes. The 757 bytes above the
/// fee (under 0.008 NEAR) are locked from the token account's spare
/// balance until the exits close. An account that goes that far has paid
/// 0.02 NEAR it never gets back, so it pays more than it locks.
const STORAGE_MIN_YOCTO: u128 = 20_000_000_000_000_000_000_000;
/// Metadata sits in the root state, which every call reads, callbacks with
/// fixed gas included. The limits keep that read small.
const MAX_NAME_BYTES: usize = 64;
const MAX_SYMBOL_BYTES: usize = 16;
const MAX_ICON_BYTES: usize = 2_048;
const DECIMALS: u8 = 18;
const FT_ON_TRANSFER_TGAS: u64 = 30;
const FT_RESOLVE_TGAS: u64 = 10;
/// Gas reserved for `on_payout`, the callback behind every NEAR payout.
const PAYOUT_CALLBACK_TGAS: u64 = 10;

/// Stops the call. The message always starts with an error code. Every
/// code is listed in SPEC 7: most with the method that raises them, and
/// E_AMOUNT (zero amount, a buy that rounds to zero tokens, or a sale that
/// rounds to zero yoctoNEAR), E_SELF (sender equals receiver), E_NO_EXIT
/// (unknown exit id), E_MATH (pool math overflow) and E_UNREGISTERED (the
/// receiver has not paid storage) at the top of it.
fn fail(msg: &str) -> ! {
    if cfg!(test) {
        // A plain panic keeps the message readable in unit tests.
        panic!("{}", msg);
    }
    env::panic_str(msg)
}

fn require_one_yocto() {
    if env::attached_deposit().as_yoctonear() != 1 {
        fail("E_YOCTO: attach exactly 1 yoctoNEAR");
    }
}

/// Tokens credited to the token account's own balance could never move
/// again: the account has no key, so nobody can sign a transfer from it.
fn require_not_token_account(receiver_id: &AccountId) {
    if *receiver_id == env::current_account_id() {
        fail("E_RECEIVER: the token account cannot receive tokens");
    }
}

/// Sends NEAR and attaches the `on_payout` callback, which records the
/// amount as owed if the transfer receipt fails. The promise is detached,
/// so the calling method keeps its own return value.
fn pay(to: &AccountId, yocto: u128) {
    if yocto > 0 {
        let callback_args = json!({
            "account": to,
            "amount": U128(yocto)
        })
        .to_string()
        .into_bytes();
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(yocto))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_payout",
                callback_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(PAYOUT_CALLBACK_TGAS),
            ))
            .detach();
    }
}

fn emit(standard: &str, event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        standard, event, data
    ));
}

fn emit_loud(event: &str, data: Value) {
    emit("loud", event, data);
}

fn emit_ft_mint(owner: &AccountId, amount: u128) {
    emit("nep141", "ft_mint", json!({ "owner_id": owner, "amount": U128(amount) }));
}

fn emit_ft_transfer(from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
    let data = match memo {
        Some(memo) => json!({
            "old_owner_id": from,
            "new_owner_id": to,
            "amount": U128(amount),
            "memo": memo
        }),
        None => json!({
            "old_owner_id": from,
            "new_owner_id": to,
            "amount": U128(amount)
        }),
    };
    emit("nep141", "ft_transfer", data);
}

/// An open exit as stored.
#[near(serializers=[borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ExitRecord {
    pub id: u64,
    pub owner: AccountId,
    pub amount: u128,
    pub remaining: u128,
    pub shouted_at: u64,
    pub ready_at: u64,
    pub expires_at: u64,
}

/// An open exit as returned by views.
#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Exit {
    pub id: U64,
    pub owner: AccountId,
    pub amount: U128,
    pub remaining: U128,
    pub shouted_at: U64,
    pub ready_at: U64,
    pub expires_at: U64,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub total_supply: U128,
    pub creator: AccountId,
    pub creator_alloc_bps: u16,
    pub virtual_near: U128,
    pub loud_window_ns: U64,
    pub notice_ns: U64,
    pub exit_window_ns: U64,
    pub cap_bps: u16,
    pub cap_window_ns: U64,
    pub launch_ts: U64,
    pub loud_until: U64,
    pub cap_units: U128,
    pub creator_alloc: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub pool_tokens: U128,
    pub pool_near: U128,
    pub loud_outstanding: U128,
    pub escrowed: U128,
    /// Units that may leave at `now`.
    pub cap_available: U128,
    pub cap_units: U128,
    /// Earliest time with at least one unit of room; equals `now` when
    /// `cap_available > 0`.
    pub next_room_ts: U64,
    /// Time at which the bucket is full again if nobody leaves.
    pub cap_full_ts: U64,
    pub open_exits: u32,
    pub total_shouted: U128,
    pub total_left: U128,
    pub shout_count: u64,
    pub leave_count: u64,
    pub now: U64,
    pub is_loud_window: bool,
    /// YoctoNEAR of failed payouts waiting for `claim`. Not part of
    /// `pool_near`.
    pub owed_total: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountView {
    pub loud: U128,
    pub quiet: U128,
    pub exits: Vec<Exit>,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Loud {
    // Immutable after `new` (SPEC 3).
    total_supply: u128,
    creator: AccountId,
    creator_alloc_bps: u16,
    creator_alloc: u128,
    virtual_near: u128,
    loud_window_ns: u64,
    notice_ns: u64,
    exit_window_ns: u64,
    cap_bps: u16,
    cap_window_ns: u64,
    launch_ts: u64,
    loud_until: u64,
    cap_units: u128,
    name: String,
    symbol: String,
    icon: Option<String>,

    // Mutable state (SPEC 4).
    pool_tokens: u128,
    pool_near: u128,
    loud: LookupMap<AccountId, u128>,
    quiet: LookupMap<AccountId, u128>,
    loud_outstanding: u128,
    escrowed: u128,
    bucket_units: u128,
    bucket_ts: u64,
    exits: IterableMap<u64, ExitRecord>,
    /// Open exit ids per account, in creation order.
    account_exits: LookupMap<AccountId, Vec<u64>>,
    next_exit_id: u64,
    total_shouted: u128,
    total_left: u128,
    shout_count: u64,
    leave_count: u64,
    /// YoctoNEAR of payouts whose transfer receipt failed, per account.
    /// `pool_near` was already reduced when the sale happened, so owed
    /// NEAR is not in `pool_near`: it sits in this account's balance next
    /// to it until the account calls `claim`.
    owed: LookupMap<AccountId, u128>,
    owed_total: u128,
    /// Accounts that paid the storage fee. Only these can receive tokens,
    /// so every balance entry belongs to an account that paid for it.
    registered: LookupSet<AccountId>,
}

#[near]
impl Loud {
    // Init

    /// Mints the fixed supply: the creator allocation as loud, the rest to
    /// the pool. Callable once. The creator is registered without a fee;
    /// the deployer funds the account that stores it.
    #[init(ignore_state)]
    pub fn new(
        total_supply: U128,
        creator: AccountId,
        creator_alloc_bps: u16,
        virtual_near: U128,
        loud_window_ns: U64,
        notice_ns: U64,
        exit_window_ns: U64,
        cap_bps: u16,
        cap_window_ns: U64,
        name: String,
        symbol: String,
        icon: Option<String>,
    ) -> Self {
        if env::state_exists() {
            fail("E_INIT: already initialized");
        }
        let total_supply = total_supply.0;
        let virtual_near = virtual_near.0;
        let loud_window_ns = loud_window_ns.0;
        let notice_ns = notice_ns.0;
        let exit_window_ns = exit_window_ns.0;
        let cap_window_ns = cap_window_ns.0;

        if !(MIN_SUPPLY..=MAX_SUPPLY).contains(&total_supply) {
            fail("E_PARAMS: total_supply must be 10^24 ..= 10^30 units");
        }
        if creator_alloc_bps > MAX_CREATOR_BPS {
            fail("E_PARAMS: creator_alloc_bps must be 0 ..= 2000");
        }
        if !(MIN_VIRTUAL_NEAR..=MAX_VIRTUAL_NEAR).contains(&virtual_near) {
            fail("E_PARAMS: virtual_near must be 10^23 ..= 10^30 yoctoNEAR");
        }
        if !(MIN_LOUD_WINDOW_NS..=SEVEN_DAYS_NS).contains(&loud_window_ns) {
            fail("E_PARAMS: loud_window_ns must be 60 s ..= 7 days");
        }
        if !(MIN_NOTICE_NS..=SEVEN_DAYS_NS).contains(&notice_ns) {
            fail("E_PARAMS: notice_ns must be 30 s ..= 7 days");
        }
        if !(MIN_EXIT_WINDOW_NS..=SEVEN_DAYS_NS).contains(&exit_window_ns) {
            fail("E_PARAMS: exit_window_ns must be 60 s ..= 7 days");
        }
        if cap_bps == 0 || cap_bps > MAX_CAP_BPS {
            fail("E_PARAMS: cap_bps must be 1 ..= 1000");
        }
        if !(MIN_CAP_WINDOW_NS..=SEVEN_DAYS_NS).contains(&cap_window_ns) {
            fail("E_PARAMS: cap_window_ns must be 60 s ..= 7 days");
        }
        // The token account has no key: an allocation minted to it could
        // never be moved or shouted.
        if creator == env::current_account_id() {
            fail("E_PARAMS: creator cannot be the token account");
        }
        if name.len() > MAX_NAME_BYTES {
            fail("E_PARAMS: name must be at most 64 bytes");
        }
        if symbol.len() > MAX_SYMBOL_BYTES {
            fail("E_PARAMS: symbol must be at most 16 bytes");
        }
        if icon.as_ref().is_some_and(|i| i.len() > MAX_ICON_BYTES) {
            fail("E_PARAMS: icon must be at most 2048 bytes");
        }

        let launch_ts = env::block_timestamp();
        let loud_until = match launch_ts.checked_add(loud_window_ns) {
            Some(v) => v,
            None => fail("E_PARAMS: loud window overflows the clock"),
        };
        let creator_alloc = loud_math::mul_div(total_supply, creator_alloc_bps as u128, BPS);
        let cap_units = loud_math::mul_div(total_supply, cap_bps as u128, BPS);
        let pool_tokens = total_supply - creator_alloc;

        let mut this = Self {
            total_supply,
            creator: creator.clone(),
            creator_alloc_bps,
            creator_alloc,
            virtual_near,
            loud_window_ns,
            notice_ns,
            exit_window_ns,
            cap_bps,
            cap_window_ns,
            launch_ts,
            loud_until,
            cap_units,
            name,
            symbol,
            icon,
            pool_tokens,
            pool_near: 0,
            loud: LookupMap::new(b"l"),
            quiet: LookupMap::new(b"q"),
            loud_outstanding: creator_alloc,
            escrowed: 0,
            bucket_units: 0,
            bucket_ts: launch_ts,
            exits: IterableMap::new(b"e"),
            account_exits: LookupMap::new(b"x"),
            next_exit_id: 1,
            total_shouted: 0,
            total_left: 0,
            shout_count: 0,
            leave_count: 0,
            owed: LookupMap::new(b"o"),
            owed_total: 0,
            registered: LookupSet::new(b"r"),
        };

        this.registered.insert(creator.clone());
        if creator_alloc > 0 {
            this.loud.insert(creator.clone(), creator_alloc);
            emit_ft_mint(&creator, creator_alloc);
        }
        emit_ft_mint(&env::current_account_id(), pool_tokens);
        this
    }

    // Trading (SPEC 5, 7)

    /// Buys from the pool with the attached NEAR. Tokens are loud while the
    /// launch window is open and quiet afterwards.
    /// A caller that is not registered yet is registered here: the storage
    /// fee comes out of the deposit first and never enters the pool.
    #[payable]
    pub fn buy(&mut self, min_tokens_out: U128) -> U128 {
        let now = self.touch();
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let storage_paid = if self.registered.contains(&caller) { 0 } else { STORAGE_MIN_YOCTO };
        let near_in = match deposit.checked_sub(storage_paid) {
            Some(v) if v >= MIN_BUY_YOCTO => v,
            _ if storage_paid > 0 => fail(
                "E_DEPOSIT: attach at least 0.001 NEAR plus the one-time 0.02 NEAR storage fee of a new account",
            ),
            _ => fail("E_DEPOSIT: attach at least 0.001 NEAR"),
        };
        let out = match loud_math::buy_out(self.pool_tokens, self.reserve(), near_in) {
            Some(v) => v,
            None => fail("E_MATH: deposit is too large for the pool math"),
        };
        if out == 0 || out >= self.pool_tokens {
            fail("E_AMOUNT: buy size out of range");
        }
        if out < min_tokens_out.0 {
            fail(&format!(
                "E_SLIPPAGE: tokens out {} is below min_tokens_out {}",
                out, min_tokens_out.0
            ));
        }

        // Registered only now, after every check has passed.
        if storage_paid > 0 {
            self.registered.insert(caller.clone());
        }
        self.pool_near += near_in;
        self.pool_tokens -= out;
        let is_loud = now < self.loud_until;
        if is_loud {
            self.add_loud(&caller, out);
            self.loud_outstanding += out;
        } else {
            self.add_quiet(&caller, out);
        }

        emit_ft_transfer(&env::current_account_id(), &caller, out, None);
        emit_loud(
            "buy",
            json!({
                "account": caller,
                "near_in": U128(near_in),
                "storage_paid": U128(storage_paid),
                "tokens_out": U128(out),
                "loud": is_loud
            }),
        );
        U128(out)
    }

    /// Sells quiet tokens to the pool. Loud tokens are never used here.
    /// Returns the yoctoNEAR sent to the caller.
    #[payable]
    pub fn sell(&mut self, amount: U128, min_near_out: U128) -> U128 {
        self.touch();
        require_one_yocto();
        let caller = env::predecessor_account_id();
        let amount = amount.0;
        if amount == 0 {
            fail("E_AMOUNT: amount must be positive");
        }
        let quiet = self.quiet_of(&caller);
        if amount > quiet {
            fail(&format!(
                "E_NO_QUIET: sell uses quiet tokens only; you hold {} loud and {} quiet units and asked to sell {}; loud tokens must use shout, then leave",
                self.loud_of(&caller),
                quiet,
                amount
            ));
        }
        let near_out = self.pool_sell(amount, min_near_out.0, amount);
        self.set_quiet(&caller, quiet - amount);
        pay(&caller, near_out);

        emit_ft_transfer(&caller, &env::current_account_id(), amount, None);
        emit_loud(
            "sell",
            json!({
                "account": caller,
                "tokens_in": U128(amount),
                "near_out": U128(near_out)
            }),
        );
        U128(near_out)
    }

    // The door for loud tokens

    /// Announces an exit and escrows the tokens. Returns the exit id.
    /// An amount below the dust floor is accepted only when it is the
    /// caller's whole loud balance, so a small remainder is never stuck.
    #[payable]
    pub fn shout(&mut self, amount: U128) -> U64 {
        let now = self.touch();
        require_one_yocto();
        let caller = env::predecessor_account_id();
        let amount = amount.0;
        let loud = self.loud_of(&caller);
        if amount == 0 || amount > loud {
            fail(&format!(
                "E_NO_LOUD: asked to shout {} units but you hold {} loud units",
                amount, loud
            ));
        }
        let dust = self.total_supply / DUST_DIVISOR;
        if amount < dust && amount != loud {
            fail(&format!(
                "E_DUST: a shout must be at least {} units, or your whole loud balance of {} units",
                dust, loud
            ));
        }
        let mut ids = self.exit_ids(&caller);
        if ids.len() >= MAX_EXITS_PER_ACCOUNT {
            fail("E_TOO_MANY: at most 8 open exits per account");
        }

        let id = self.next_exit_id;
        self.next_exit_id += 1;
        let ready_at = now.saturating_add(self.notice_ns);
        let expires_at = ready_at.saturating_add(self.exit_window_ns);

        self.set_loud(&caller, loud - amount);
        self.escrowed += amount;
        self.exits.insert(
            id,
            ExitRecord {
                id,
                owner: caller.clone(),
                amount,
                remaining: amount,
                shouted_at: now,
                ready_at,
                expires_at,
            },
        );
        ids.push(id);
        self.account_exits.insert(caller.clone(), ids);
        // Display counters only: they saturate, so they can never stop a call.
        self.total_shouted = self.total_shouted.saturating_add(amount);
        self.shout_count = self.shout_count.saturating_add(1);

        emit_ft_transfer(&caller, &env::current_account_id(), amount, Some("shout"));
        emit_loud(
            "shout",
            json!({
                "id": U64(id),
                "account": caller,
                "amount": U128(amount),
                "ready_at": U64(ready_at),
                "expires_at": U64(expires_at)
            }),
        );
        U64(id)
    }

    /// Sells as much of a ready exit as the global cap allows right now,
    /// and no more than the pool can pay for.
    /// `min_near_out` is the least NEAR the caller accepts for everything
    /// that is left in the exit. A partial fill is held to the same price:
    /// it needs `near_out * remaining >= min_near_out * fill`, with
    /// `remaining` read before this fill. Returns the units filled.
    #[payable]
    pub fn leave(&mut self, exit_id: U64, min_near_out: U128) -> U128 {
        let now = self.touch();
        require_one_yocto();
        let caller = env::predecessor_account_id();
        let id = exit_id.0;
        let exit = match self.exits.get(&id) {
            Some(e) => e.clone(),
            None => fail("E_NO_EXIT: no open exit with this id"),
        };
        if exit.owner != caller {
            fail("E_NOT_OWNER: only the exit owner can leave");
        }
        if now < exit.ready_at {
            let left_ns = exit.ready_at - now;
            fail(&format!(
                "E_NOTICE: the notice period ends in {} s",
                left_ns.div_ceil(SECOND_NS)
            ));
        }
        if now > exit.expires_at {
            fail("E_EXPIRED: this exit has expired; call hush to get the loud tokens back");
        }
        // `touch` refilled the bucket, so `bucket_units` is available(now).
        let mut fill = core::cmp::min(exit.remaining, self.bucket_units);
        if fill == 0 {
            let (next_room, full) = self.room_times(now);
            fail(&format!(
                "E_CAP: the global cap has no room right now; room returns from timestamp {} ns and the cap is full again at {} ns",
                next_room, full
            ));
        }
        // If the pool cannot pay for all of it, fill what it can pay for.
        let payable = match loud_math::sell_out(self.pool_tokens, self.reserve(), fill) {
            Some(v) => v <= self.pool_near,
            None => false,
        };
        if !payable {
            fill = core::cmp::min(
                fill,
                loud_math::max_sell(self.pool_tokens, self.virtual_near, self.pool_near),
            );
            if fill == 0 {
                fail(&format!(
                    "E_POOL_EMPTY: the pool holds {} yoctoNEAR and cannot pay for any part of this exit",
                    self.pool_near
                ));
            }
        }
        let near_out = self.pool_sell(fill, min_near_out.0, exit.remaining);

        self.bucket_units -= fill;
        self.escrowed -= fill;
        self.loud_outstanding -= fill;
        self.total_left = self.total_left.saturating_add(fill);
        self.leave_count = self.leave_count.saturating_add(1);
        let remaining = exit.remaining - fill;
        if remaining == 0 {
            self.remove_exit(id, &exit.owner);
        } else {
            let mut updated = exit.clone();
            updated.remaining = remaining;
            self.exits.insert(id, updated);
        }
        pay(&exit.owner, near_out);

        emit_loud(
            "leave",
            json!({
                "id": U64(id),
                "account": exit.owner,
                "filled": U128(fill),
                "remaining": U128(remaining),
                "near_out": U128(near_out)
            }),
        );
        U128(fill)
    }

    /// Closes an expired exit and returns what is left of it to the owner
    /// as loud. A shout is binding: until `expires_at` has passed nobody can
    /// take it back, the owner included, so a notice on the board always
    /// has its tokens locked behind it. After that anyone may call.
    #[payable]
    pub fn hush(&mut self, exit_id: U64) {
        let now = self.touch();
        require_one_yocto();
        let caller = env::predecessor_account_id();
        let id = exit_id.0;
        let exit = match self.exits.get(&id) {
            Some(e) => e.clone(),
            None => fail("E_NO_EXIT: no open exit with this id"),
        };
        if now <= exit.expires_at {
            fail(&format!(
                "E_NOTICE_BINDING: a shout cannot be taken back; this exit can be closed once it has expired, after timestamp {} ns",
                exit.expires_at
            ));
        }
        self.remove_exit(id, &exit.owner);
        self.escrowed -= exit.remaining;
        self.add_loud(&exit.owner, exit.remaining);

        emit_ft_transfer(&env::current_account_id(), &exit.owner, exit.remaining, Some("hush"));
        emit_loud(
            "hush",
            json!({
                "id": U64(id),
                "account": exit.owner,
                "amount": U128(exit.remaining),
                "by": caller
            }),
        );
    }

    // Failed payouts

    /// Callback of every payout made by `pay`. If the transfer receipt
    /// failed, the NEAR came back to this account, so the amount is
    /// recorded as owed to `account`. A successful transfer changes nothing.
    /// It does nothing else, not even the bucket refill: the less it does,
    /// the less can stop it from recording the debt.
    #[private]
    pub fn on_payout(&mut self, account: AccountId, amount: U128) {
        // `#[private]` guards the exported method; this check also covers
        // direct calls, such as unit tests.
        if env::predecessor_account_id() != env::current_account_id() {
            fail("E_PRIVATE: only the token account can call on_payout");
        }
        // A transfer returns no data, so any error here is a failed receipt.
        if env::promise_result_checked(0, 16).is_err() {
            let owed = self.owed_of(&account);
            self.owed.insert(account.clone(), owed + amount.0);
            self.owed_total += amount.0;
            emit_loud(
                "payout_failed",
                json!({
                    "account": account,
                    "amount": amount
                }),
            );
        }
    }

    /// Pays the caller the NEAR recorded as owed after a failed payout.
    /// The entry is cleared first; if this transfer fails too, `on_payout`
    /// records it again. Returns the yoctoNEAR sent.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        self.touch();
        require_one_yocto();
        let caller = env::predecessor_account_id();
        let amount = self.owed_of(&caller);
        if amount == 0 {
            fail("E_NOTHING_OWED: no failed payout is recorded for this account");
        }
        self.owed.remove(&caller);
        self.owed_total -= amount;
        pay(&caller, amount);

        emit_loud(
            "claim",
            json!({
                "account": caller,
                "amount": U128(amount)
            }),
        );
        U128(amount)
    }

    // NEP-141

    /// Takes quiet first, then loud. The receiver gets the same split.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.touch();
        require_one_yocto();
        let sender = env::predecessor_account_id();
        if sender == receiver_id {
            fail("E_SELF: sender and receiver must differ");
        }
        require_not_token_account(&receiver_id);
        self.require_registered(&receiver_id);
        let amount = amount.0;
        if amount == 0 {
            fail("E_AMOUNT: amount must be positive");
        }
        let quiet = self.quiet_of(&sender);
        let loud = self.loud_of(&sender);
        let quiet_part = core::cmp::min(amount, quiet);
        let loud_part = amount - quiet_part;
        if loud_part > loud {
            fail(&format!(
                "E_BALANCE: asked to move {} units but you hold {} loud and {} quiet",
                amount, loud, quiet
            ));
        }
        if quiet_part > 0 {
            self.set_quiet(&sender, quiet - quiet_part);
            self.add_quiet(&receiver_id, quiet_part);
        }
        if loud_part > 0 {
            self.set_loud(&sender, loud - loud_part);
            self.add_loud(&receiver_id, loud_part);
        }
        emit_ft_transfer(&sender, &receiver_id, amount, memo.as_deref());
        if loud_part > 0 {
            emit_loud(
                "tag_move",
                json!({
                    "from": sender,
                    "to": receiver_id,
                    "loud_amount": U128(loud_part)
                }),
            );
        }
    }

    /// Moves loud tokens explicitly. They stay loud at the receiver.
    #[payable]
    pub fn transfer_loud(&mut self, receiver_id: AccountId, amount: U128) {
        self.touch();
        require_one_yocto();
        let sender = env::predecessor_account_id();
        if sender == receiver_id {
            fail("E_SELF: sender and receiver must differ");
        }
        require_not_token_account(&receiver_id);
        self.require_registered(&receiver_id);
        let amount = amount.0;
        let loud = self.loud_of(&sender);
        if amount == 0 || amount > loud {
            fail(&format!(
                "E_NO_LOUD: asked to move {} loud units but you hold {}",
                amount, loud
            ));
        }
        self.set_loud(&sender, loud - amount);
        self.add_loud(&receiver_id, amount);
        emit_ft_transfer(&sender, &receiver_id, amount, Some("transfer_loud"));
        emit_loud(
            "tag_move",
            json!({
                "from": sender,
                "to": receiver_id,
                "loud_amount": U128(amount)
            }),
        );
    }

    /// Quiet tokens only. Loud tokens cannot enter other contracts this way.
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        self.touch();
        require_one_yocto();
        let sender = env::predecessor_account_id();
        if sender == receiver_id {
            fail("E_SELF: sender and receiver must differ");
        }
        require_not_token_account(&receiver_id);
        self.require_registered(&receiver_id);
        if amount.0 == 0 {
            fail("E_AMOUNT: amount must be positive");
        }
        let quiet = self.quiet_of(&sender);
        if amount.0 > quiet {
            fail(&format!(
                "E_QUIET_DOOR: loud tokens cannot go into other contracts through ft_transfer_call; you hold {} quiet units",
                quiet
            ));
        }
        self.set_quiet(&sender, quiet - amount.0);
        self.add_quiet(&receiver_id, amount.0);
        emit_ft_transfer(&sender, &receiver_id, amount.0, memo.as_deref());

        let on_transfer_args = json!({
            "sender_id": sender,
            "amount": amount,
            "msg": msg
        })
        .to_string()
        .into_bytes();
        let resolve_args = json!({
            "sender_id": sender,
            "receiver_id": receiver_id,
            "amount": amount
        })
        .to_string()
        .into_bytes();
        Promise::new(receiver_id)
            .function_call(
                "ft_on_transfer",
                on_transfer_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(FT_ON_TRANSFER_TGAS),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "ft_resolve_transfer",
                resolve_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(FT_RESOLVE_TGAS),
            ))
    }

    /// Callback of `ft_transfer_call`. Refunds the unused part as quiet and
    /// returns the amount the receiver kept.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.touch();
        let amount = amount.0;
        let unused = match env::promise_result_checked(0, 256) {
            Ok(bytes) => match near_sdk::serde_json::from_slice::<U128>(&bytes) {
                Ok(v) => core::cmp::min(amount, v.0),
                Err(_) => amount,
            },
            Err(_) => amount,
        };
        let receiver_quiet = self.quiet_of(&receiver_id);
        let refund = core::cmp::min(unused, receiver_quiet);
        if refund > 0 {
            self.set_quiet(&receiver_id, receiver_quiet - refund);
            self.add_quiet(&sender_id, refund);
            emit_ft_transfer(&receiver_id, &sender_id, refund, Some("refund"));
        }
        U128(amount - refund)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    /// Loud plus quiet. For the token account itself the pool inventory and
    /// the tokens escrowed in open exits are added: the `ft_mint` and
    /// `ft_transfer` events name this account as their owner, so the sum of
    /// all balances equals `ft_total_supply`.
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        let mut balance = self.loud_of(&account_id) + self.quiet_of(&account_id);
        if account_id == env::current_account_id() {
            balance += self.pool_tokens + self.escrowed;
        }
        U128(balance)
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: self.icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }

    // NEP-145 registration: one fixed fee per account, paid once

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_MIN_YOCTO), max: Some(U128(STORAGE_MIN_YOCTO)) }
    }

    /// Registers `account_id` (the caller if omitted) for the fixed fee and
    /// refunds whatever was attached above it. If the account is already
    /// registered the whole deposit goes back. Anyone can pay for anyone.
    /// There is no withdraw and no unregister: the fee stays.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        // The fee is a single fixed amount, so the flag has nothing to choose.
        let _ = registration_only;
        let payer = env::predecessor_account_id();
        let account = account_id.unwrap_or_else(|| payer.clone());
        let deposit = env::attached_deposit().as_yoctonear();
        let refund = if self.registered.contains(&account) {
            deposit
        } else {
            let rest = match deposit.checked_sub(STORAGE_MIN_YOCTO) {
                Some(v) => v,
                None => fail("E_STORAGE: attach at least 0.02 NEAR to register an account"),
            };
            self.registered.insert(account);
            rest
        };
        pay(&payer, refund);
        StorageBalance { total: U128(STORAGE_MIN_YOCTO), available: U128(0) }
    }

    /// `None` for an account that is not registered.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        if self.registered.contains(&account_id) {
            Some(StorageBalance { total: U128(STORAGE_MIN_YOCTO), available: U128(0) })
        } else {
            None
        }
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.registered.contains(&account_id)
    }

    // Views

    pub fn get_params(&self) -> Params {
        Params {
            total_supply: U128(self.total_supply),
            creator: self.creator.clone(),
            creator_alloc_bps: self.creator_alloc_bps,
            virtual_near: U128(self.virtual_near),
            loud_window_ns: U64(self.loud_window_ns),
            notice_ns: U64(self.notice_ns),
            exit_window_ns: U64(self.exit_window_ns),
            cap_bps: self.cap_bps,
            cap_window_ns: U64(self.cap_window_ns),
            launch_ts: U64(self.launch_ts),
            loud_until: U64(self.loud_until),
            cap_units: U128(self.cap_units),
            creator_alloc: U128(self.creator_alloc),
        }
    }

    pub fn get_state(&self) -> State {
        let now = env::block_timestamp();
        let (next_room, full) = self.room_times(now);
        State {
            pool_tokens: U128(self.pool_tokens),
            pool_near: U128(self.pool_near),
            loud_outstanding: U128(self.loud_outstanding),
            escrowed: U128(self.escrowed),
            cap_available: U128(self.available(now)),
            cap_units: U128(self.cap_units),
            next_room_ts: U64(next_room),
            cap_full_ts: U64(full),
            open_exits: self.exits.len(),
            total_shouted: U128(self.total_shouted),
            total_left: U128(self.total_left),
            shout_count: self.shout_count,
            leave_count: self.leave_count,
            now: U64(now),
            is_loud_window: now < self.loud_until,
            owed_total: U128(self.owed_total),
        }
    }

    /// YoctoNEAR owed to `account_id` after failed payouts; see `claim`.
    pub fn get_owed(&self, account_id: AccountId) -> U128 {
        U128(self.owed_of(&account_id))
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let mut exits = Vec::new();
        for id in self.exit_ids(&account_id) {
            if let Some(e) = self.exits.get(&id) {
                exits.push(exit_view(e));
            }
        }
        AccountView {
            loud: U128(self.loud_of(&account_id)),
            quiet: U128(self.quiet_of(&account_id)),
            exits,
        }
    }

    /// A page of open exits. Reads at most 100 exits, whatever the number
    /// of open exits. With up to 100 open exits the list is ordered by id
    /// (the order they were shouted in) before paging. With more, pages
    /// follow storage order and each page is ordered by id.
    pub fn get_exits(&self, from_index: u32, limit: u32) -> Vec<Exit> {
        let limit = core::cmp::min(limit, MAX_EXITS_PAGE) as usize;
        let from = from_index as usize;
        if self.exits.len() <= MAX_EXITS_PAGE {
            let mut all: Vec<&ExitRecord> = self.exits.values().collect();
            all.sort_by_key(|e| e.id);
            return all.into_iter().skip(from).take(limit).map(exit_view).collect();
        }
        // `skip` moves by index and does not read the skipped entries.
        let mut page: Vec<&ExitRecord> = self.exits.values().skip(from).take(limit).collect();
        page.sort_by_key(|e| e.id);
        page.into_iter().map(exit_view).collect()
    }

    /// Tokens a buy of `near` yoctoNEAR would return now. Zero if the pool
    /// math cannot serve it.
    pub fn quote_buy(&self, near: U128) -> U128 {
        U128(loud_math::buy_out(self.pool_tokens, self.reserve(), near.0).unwrap_or(0))
    }

    /// YoctoNEAR the pool formula returns for `amount` units now. A real
    /// sale also needs this to be at most `pool_near`.
    pub fn quote_sell(&self, amount: U128) -> U128 {
        U128(loud_math::sell_out(self.pool_tokens, self.reserve(), amount.0).unwrap_or(0))
    }
}

fn exit_view(e: &ExitRecord) -> Exit {
    Exit {
        id: U64(e.id),
        owner: e.owner.clone(),
        amount: U128(e.amount),
        remaining: U128(e.remaining),
        shouted_at: U64(e.shouted_at),
        ready_at: U64(e.ready_at),
        expires_at: U64(e.expires_at),
    }
}

// Internal helpers. Not exported as contract methods.
impl Loud {
    /// Refills the cap bucket (SPEC 6) and returns the block time.
    fn touch(&mut self) -> u64 {
        let now = env::block_timestamp();
        let (units, ts) = loud_math::bucket_refill(
            self.cap_units,
            self.cap_window_ns,
            self.bucket_units,
            self.bucket_ts,
            now,
        );
        self.bucket_units = units;
        self.bucket_ts = ts;
        now
    }

    fn available(&self, now: u64) -> u128 {
        loud_math::bucket_available(
            self.cap_units,
            self.cap_window_ns,
            self.bucket_units,
            self.bucket_ts,
            now,
        )
    }

    /// `(next_room_ts, cap_full_ts)` as described on `State`.
    fn room_times(&self, now: u64) -> (u64, u64) {
        let one_unit = loud_math::bucket_wait_ns(self.cap_units, self.cap_window_ns, 1);
        let next_room = if self.available(now) > 0 {
            now
        } else {
            core::cmp::max(now, self.bucket_ts.saturating_add(one_unit))
        };
        let missing = self.cap_units.saturating_sub(self.bucket_units);
        let to_full = loud_math::bucket_wait_ns(self.cap_units, self.cap_window_ns, missing);
        let full = core::cmp::max(now, self.bucket_ts.saturating_add(to_full));
        (next_room, full)
    }

    /// `R` of SPEC 5.
    fn reserve(&self) -> u128 {
        match self.virtual_near.checked_add(self.pool_near) {
            Some(v) => v,
            None => fail("E_MATH: reserve overflow"),
        }
    }

    /// Pool side of a sale: checks the sale pays something, the pool can
    /// pay it and the slippage limit, then updates the reserves. Returns
    /// the yoctoNEAR owed.
    ///
    /// `min_near_out` is the limit for `whole` units and is scaled to the
    /// `amount` sold now: the sale needs
    /// `near_out * whole >= min_near_out * amount`. `sell` passes
    /// `whole == amount`, which is the plain `near_out >= min_near_out`.
    fn pool_sell(&mut self, amount: u128, min_near_out: u128, whole: u128) -> u128 {
        let near_out = match loud_math::sell_out(self.pool_tokens, self.reserve(), amount) {
            Some(v) => v,
            None => fail("E_MATH: amount is too large for the pool math"),
        };
        if near_out == 0 {
            fail("E_AMOUNT: this sale is too small to pay anything");
        }
        if near_out > self.pool_near {
            fail(&format!(
                "E_POOL_EMPTY: the pool holds {} yoctoNEAR but this sale needs {}",
                self.pool_near, near_out
            ));
        }
        // Both products are 256 bits wide, so the comparison is exact and
        // cannot overflow. `(high, low)` pairs compare high word first.
        if loud_math::mul_wide(near_out, whole) < loud_math::mul_wide(min_near_out, amount) {
            if amount == whole {
                fail(&format!(
                    "E_SLIPPAGE: near out {} is below min_near_out {}",
                    near_out, min_near_out
                ));
            }
            fail(&format!(
                "E_SLIPPAGE: near out {} for {} of {} units is below min_near_out {} scaled to the part filled",
                near_out, amount, whole, min_near_out
            ));
        }
        self.pool_near -= near_out;
        self.pool_tokens += amount;
        near_out
    }

    /// A balance entry costs storage, so tokens only go to accounts that
    /// paid for theirs. Senders need no check: a holder is registered.
    fn require_registered(&self, account: &AccountId) {
        if !self.registered.contains(account) {
            fail(&format!(
                "E_UNREGISTERED: {} is not registered; call storage_deposit for it first",
                account
            ));
        }
    }

    fn loud_of(&self, account: &AccountId) -> u128 {
        self.loud.get(account).copied().unwrap_or(0)
    }

    fn quiet_of(&self, account: &AccountId) -> u128 {
        self.quiet.get(account).copied().unwrap_or(0)
    }

    fn owed_of(&self, account: &AccountId) -> u128 {
        self.owed.get(account).copied().unwrap_or(0)
    }

    fn set_loud(&mut self, account: &AccountId, value: u128) {
        if value == 0 {
            self.loud.remove(account);
        } else {
            self.loud.insert(account.clone(), value);
        }
    }

    fn set_quiet(&mut self, account: &AccountId, value: u128) {
        if value == 0 {
            self.quiet.remove(account);
        } else {
            self.quiet.insert(account.clone(), value);
        }
    }

    fn add_loud(&mut self, account: &AccountId, value: u128) {
        let current = self.loud_of(account);
        self.set_loud(account, current + value);
    }

    fn add_quiet(&mut self, account: &AccountId, value: u128) {
        let current = self.quiet_of(account);
        self.set_quiet(account, current + value);
    }

    fn exit_ids(&self, account: &AccountId) -> Vec<u64> {
        self.account_exits.get(account).cloned().unwrap_or_default()
    }

    fn remove_exit(&mut self, id: u64, owner: &AccountId) {
        self.exits.remove(&id);
        let mut ids = self.exit_ids(owner);
        ids.retain(|x| *x != id);
        if ids.is_empty() {
            self.account_exits.remove(owner);
        } else {
            self.account_exits.insert(owner.clone(), ids);
        }
    }
}
