//! Integer math for the LOUD token contract.
//!
//! No dependencies and no allocation. Every function is pure, so the same
//! numbers can be reproduced off chain.
//!
//! All divisions round down.

#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]

const MASK64: u128 = (1u128 << 64) - 1;

/// Full 128 x 128 -> 256 bit product, returned as `(high, low)`.
pub const fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let a0 = a & MASK64;
    let a1 = a >> 64;
    let b0 = b & MASK64;
    let b1 = b >> 64;

    let ll = a0 * b0;
    let lh = a0 * b1;
    let hl = a1 * b0;
    let hh = a1 * b1;

    // At most 3 * (2^64 - 1), so it cannot overflow.
    let mid = (ll >> 64) + (lh & MASK64) + (hl & MASK64);
    let lo = (mid << 64) | (ll & MASK64);
    // The true product fits 256 bits, so this sum fits 128 bits.
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
    (hi, lo)
}

/// Divides the 256-bit value `(hi, lo)` by `c`. Requires `hi < c`, which is
/// exactly the condition for the quotient to fit `u128`.
const fn div_wide(hi: u128, lo: u128, c: u128) -> u128 {
    let mut rem = hi;
    let mut quo: u128 = 0;
    let mut i = 128;
    while i > 0 {
        i -= 1;
        // `rem < c` here, so `2 * rem + bit < 2 * c`: one subtraction is enough.
        // The shift can carry out of 128 bits; `carry` keeps that bit.
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            quo |= 1u128 << i;
        }
    }
    quo
}

/// `floor(a * b / c)` with a 256-bit intermediate.
/// Returns `None` if `c == 0` or the result does not fit `u128`.
pub const fn checked_mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let (hi, lo) = mul_wide(a, b);
    if hi == 0 {
        return Some(lo / c);
    }
    if hi >= c {
        return None;
    }
    Some(div_wide(hi, lo, c))
}

/// `floor(a * b / c)` with a 256-bit intermediate.
/// Panics if `c == 0` or the result does not fit `u128`.
pub const fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    match checked_mul_div(a, b, c) {
        Some(v) => v,
        None => panic!("mul_div: division by zero or overflow"),
    }
}

/// Tokens received for `near_in` yoctoNEAR.
///
/// `reserve_near` is `virtual_near + pool_near`. Result is
/// `floor(pool_tokens * near_in / (reserve_near + near_in))`.
/// Returns `None` if the sum overflows or the denominator is zero.
/// The result is always `<= pool_tokens`, and `< pool_tokens` when
/// `reserve_near > 0`.
pub const fn buy_out(pool_tokens: u128, reserve_near: u128, near_in: u128) -> Option<u128> {
    match reserve_near.checked_add(near_in) {
        Some(den) => checked_mul_div(pool_tokens, near_in, den),
        None => None,
    }
}

/// YoctoNEAR received for selling `amount` units.
///
/// Result is `floor(reserve_near * amount / (pool_tokens + amount))`.
/// Returns `None` if the sum overflows or the denominator is zero.
/// The caller still has to check the result against the real `pool_near`.
pub const fn sell_out(pool_tokens: u128, reserve_near: u128, amount: u128) -> Option<u128> {
    match pool_tokens.checked_add(amount) {
        Some(den) => checked_mul_div(reserve_near, amount, den),
        None => None,
    }
}

/// Largest amount the pool can pay for in one sale.
///
/// Result is `floor(pool_near * pool_tokens / virtual_near)`: for every
/// `amount` up to it, `sell_out(pool_tokens, virtual_near + pool_near,
/// amount) <= pool_near`. Saturates at `u128::MAX` when the result does not
/// fit or `virtual_near` is zero (the formula then never asks for more than
/// `pool_near`).
pub const fn max_sell(pool_tokens: u128, virtual_near: u128, pool_near: u128) -> u128 {
    match checked_mul_div(pool_near, pool_tokens, virtual_near) {
        Some(v) => v,
        None => u128::MAX,
    }
}

/// The part of `amount` taken by `bps` basis points:
/// `floor(amount * bps / 10_000)`.
///
/// `bps` above 10_000 counts as 10_000, so the result is never more than
/// `amount` and `amount - bps_part(amount, bps)` cannot underflow.
pub const fn bps_part(amount: u128, bps: u128) -> u128 {
    // bps <= 10_000 here, so the quotient is <= amount and fits.
    mul_div(amount, min_u128(bps, 10_000), 10_000)
}

/// The share of `total` that belongs to `part` out of `whole`, rounded up:
/// `ceil(total * part / whole)`.
///
/// `part` above `whole` counts as `whole`, so the result is never more
/// than `total`. Returns 0 when `whole` is 0. Summed over pieces that add
/// up to `whole`, the results add up to at least `total`.
pub const fn pro_rata_ceil(total: u128, part: u128, whole: u128) -> u128 {
    if whole == 0 {
        return 0;
    }
    let part = min_u128(part, whole);
    // part <= whole here, so the quotient is <= total and fits.
    let q = mul_div(total, part, whole);
    let (qh, ql) = mul_wide(q, whole);
    let (ph, pl) = mul_wide(total, part);
    if qh == ph && ql == pl {
        q
    } else {
        // A remainder means q < total * part / whole <= total.
        q + 1
    }
}

/// Units the bucket gains over `elapsed_ns`, never more than `cap_units`.
/// `cap_window_ns` must be greater than zero.
pub const fn bucket_gain(cap_units: u128, cap_window_ns: u64, elapsed_ns: u64) -> u128 {
    if elapsed_ns >= cap_window_ns {
        return cap_units;
    }
    // elapsed < window, so the result is < cap_units and cannot overflow.
    mul_div(cap_units, elapsed_ns as u128, cap_window_ns as u128)
}

const fn min_u128(a: u128, b: u128) -> u128 {
    if a < b {
        a
    } else {
        b
    }
}

/// Refills the bucket up to `now`. Returns the new `(bucket_units, bucket_ts)`.
///
/// `bucket_ts` only advances when at least one unit was added, so frequent
/// calls do not lose fractions.
pub const fn bucket_refill(
    cap_units: u128,
    cap_window_ns: u64,
    bucket_units: u128,
    bucket_ts: u64,
    now: u64,
) -> (u128, u64) {
    if now <= bucket_ts {
        return (bucket_units, bucket_ts);
    }
    let add = bucket_gain(cap_units, cap_window_ns, now - bucket_ts);
    if add == 0 {
        return (bucket_units, bucket_ts);
    }
    (min_u128(cap_units, bucket_units.saturating_add(add)), now)
}

/// Units that may leave at `now`, without changing state.
pub const fn bucket_available(
    cap_units: u128,
    cap_window_ns: u64,
    bucket_units: u128,
    bucket_ts: u64,
    now: u64,
) -> u128 {
    if now <= bucket_ts {
        return min_u128(cap_units, bucket_units);
    }
    let add = bucket_gain(cap_units, cap_window_ns, now - bucket_ts);
    min_u128(cap_units, bucket_units.saturating_add(add))
}

/// Nanoseconds the bucket needs to gain `units` (clamped to `cap_units`).
/// `cap_units` must be greater than zero.
/// Result is `ceil(units * cap_window_ns / cap_units)`, at most `cap_window_ns`.
pub const fn bucket_wait_ns(cap_units: u128, cap_window_ns: u64, units: u128) -> u64 {
    let want = min_u128(units, cap_units);
    let w = cap_window_ns as u128;
    // want <= cap_units, so the quotient is <= cap_window_ns.
    let q = mul_div(want, w, cap_units);
    let (hi, lo) = mul_wide(want, w);
    let (qhi, qlo) = mul_wide(q, cap_units);
    if hi == qhi && lo == qlo {
        q as u64
    } else {
        (q + 1) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::cmp::Ordering;

    const MAX: u128 = u128::MAX;

    // Xorshift64* PRNG, fixed seed, no external crate
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn next_u128(&mut self) -> u128 {
            ((self.next_u64() as u128) << 64) | self.next_u64() as u128
        }
        /// Random value with a random bit length, so small and large
        /// operands are both common.
        fn sized(&mut self) -> u128 {
            let bits = (self.next_u64() % 129) as u32;
            if bits == 0 {
                0
            } else {
                let v = self.next_u128() >> (128 - bits);
                v | (1u128 << (bits - 1))
            }
        }
    }

    // Slow reference: 288-bit little-endian numbers in 32-bit limbs
    type Big = [u32; 9];

    fn big_from(v: u128) -> Big {
        let mut out = [0u32; 9];
        for (i, limb) in out.iter_mut().enumerate().take(4) {
            *limb = (v >> (32 * i)) as u32;
        }
        out
    }

    fn big_mul(a: u128, b: u128) -> Big {
        let x = big_from(a);
        let y = big_from(b);
        let mut out = [0u32; 9];
        for i in 0..4 {
            let mut carry: u64 = 0;
            for j in 0..4 {
                let cur = out[i + j] as u64 + (x[i] as u64) * (y[j] as u64) + carry;
                out[i + j] = cur as u32;
                carry = cur >> 32;
            }
            let mut k = i + 4;
            while carry > 0 {
                let cur = out[k] as u64 + carry;
                out[k] = cur as u32;
                carry = cur >> 32;
                k += 1;
            }
        }
        out
    }

    fn big_add(a: &Big, b: &Big) -> Big {
        let mut out = [0u32; 9];
        let mut carry = 0u64;
        for i in 0..9 {
            let cur = a[i] as u64 + b[i] as u64 + carry;
            out[i] = cur as u32;
            carry = cur >> 32;
        }
        assert_eq!(carry, 0, "reference overflow");
        out
    }

    fn big_cmp(a: &Big, b: &Big) -> Ordering {
        for i in (0..9).rev() {
            if a[i] != b[i] {
                return a[i].cmp(&b[i]);
            }
        }
        Ordering::Equal
    }

    /// Reference bit-by-bit division of the 256-bit product by `c`.
    /// Returns `None` when `c == 0` or the quotient needs more than 128 bits.
    fn ref_mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
        if c == 0 {
            return None;
        }
        let p = big_mul(a, b);
        let cb = big_from(c);
        let mut rem: Big = [0u32; 9];
        let mut quo = [0u32; 9];
        for bit in (0..256usize).rev() {
            // rem = rem * 2 + bit(p, bit)
            let mut carry = (p[bit / 32] >> (bit % 32)) & 1;
            for limb in rem.iter_mut() {
                let next = *limb >> 31;
                *limb = (*limb << 1) | carry;
                carry = next;
            }
            if big_cmp(&rem, &cb) != Ordering::Less {
                // rem -= c
                let mut borrow = 0i64;
                for i in 0..9 {
                    let cur = rem[i] as i64 - cb[i] as i64 - borrow;
                    if cur < 0 {
                        rem[i] = (cur + (1i64 << 32)) as u32;
                        borrow = 1;
                    } else {
                        rem[i] = cur as u32;
                        borrow = 0;
                    }
                }
                quo[bit / 32] |= 1 << (bit % 32);
            }
        }
        if quo[4..].iter().any(|&l| l != 0) {
            return None;
        }
        let mut q = 0u128;
        for (i, limb) in quo.iter().enumerate().take(4) {
            q |= (*limb as u128) << (32 * i);
        }
        Some(q)
    }

    /// Checks `q * c <= a * b < q * c + c` with the reference arithmetic.
    fn assert_floor(a: u128, b: u128, c: u128, q: u128) {
        let p = big_mul(a, b);
        let qc = big_mul(q, c);
        assert_ne!(big_cmp(&qc, &p), Ordering::Greater, "q*c > a*b for {a} {b} {c}");
        let upper = big_add(&qc, &big_from(c));
        assert_eq!(big_cmp(&p, &upper), Ordering::Less, "a*b >= (q+1)*c for {a} {b} {c}");
    }

    #[test]
    fn mul_wide_edges() {
        assert_eq!(mul_wide(0, 0), (0, 0));
        assert_eq!(mul_wide(MAX, 0), (0, 0));
        assert_eq!(mul_wide(MAX, 1), (0, MAX));
        assert_eq!(mul_wide(1 << 64, 1 << 64), (1, 0));
        assert_eq!(mul_wide(1 << 127, 2), (1, 0));
        // (2^128 - 1)^2 = 2^256 - 2^129 + 1
        assert_eq!(mul_wide(MAX, MAX), (MAX - 1, 1));
        // (2^128 - 1) * 2^127
        assert_eq!(mul_wide(MAX, 1 << 127), ((1 << 127) - 1, 1 << 127));
    }

    #[test]
    fn mul_wide_matches_reference_random() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..20_000 {
            let a = rng.sized();
            let b = rng.sized();
            let (hi, lo) = mul_wide(a, b);
            let p = big_mul(a, b);
            let mut want = [0u32; 9];
            for i in 0..4 {
                want[i] = (lo >> (32 * i)) as u32;
                want[i + 4] = (hi >> (32 * i)) as u32;
            }
            assert_eq!(p, want, "a={a} b={b}");
        }
    }

    #[test]
    fn mul_div_small_values() {
        assert_eq!(mul_div(0, 0, 1), 0);
        assert_eq!(mul_div(0, MAX, MAX), 0);
        assert_eq!(mul_div(6, 7, 3), 14);
        assert_eq!(mul_div(7, 7, 2), 24);
        assert_eq!(mul_div(1, 1, 2), 0);
        assert_eq!(mul_div(10, 10, 101), 0);
        assert_eq!(mul_div(10, 10, 100), 1);
    }

    #[test]
    fn mul_div_rounds_down() {
        assert_eq!(mul_div(1 << 126, 3, 2), 3 << 125);
        assert_eq!(mul_div(MAX, 1, 2), MAX / 2);
        assert_eq!(mul_div(MAX, 2, 4), MAX / 2);
        assert_eq!(mul_div(MAX - 1, MAX, MAX), MAX - 1);
        assert_eq!(mul_div(MAX, MAX - 1, MAX), MAX - 1);
        assert_eq!(mul_div(MAX, MAX, MAX), MAX);
        // (2^128 - 1)(2^128 - 2) / (2^128 - 1) with a remainder just below c.
        assert_eq!(mul_div(MAX - 1, MAX - 1, MAX), MAX - 2);
    }

    #[test]
    fn mul_div_overflow_edges() {
        // Largest representable results.
        assert_eq!(checked_mul_div(MAX, MAX, MAX), Some(MAX));
        assert_eq!(checked_mul_div(MAX, 2, 2), Some(MAX));
        assert_eq!(checked_mul_div(MAX, 1, 1), Some(MAX));
        // One step past the edge.
        assert_eq!(checked_mul_div(MAX, 2, 1), None);
        assert_eq!(checked_mul_div(MAX, MAX, MAX - 1), None);
        assert_eq!(checked_mul_div(1 << 127, 2, 1), None);
        assert_eq!(checked_mul_div(1 << 64, 1 << 64, 1), None);
        // 2^128 / 2 = 2^127 fits, 2^129 / 2 does not.
        assert_eq!(checked_mul_div(1 << 64, 1 << 64, 2), Some(1 << 127));
        assert_eq!(checked_mul_div(1 << 65, 1 << 64, 2), None);
        // hi == c - 1 is the last high word that fits: a*b = 2^254,
        // c = 2^126 + 1, hi = 2^126.
        let c = (1u128 << 126) + 1;
        let q = checked_mul_div(1 << 127, 1 << 127, c).unwrap();
        assert_eq!(Some(q), ref_mul_div(1 << 127, 1 << 127, c));
        assert_floor(1 << 127, 1 << 127, c, q);
        // hi == c overflows: a*b = 2^254, c = 2^126.
        assert_eq!(checked_mul_div(1 << 127, 1 << 127, 1 << 126), None);
        // Division by zero.
        assert_eq!(checked_mul_div(1, 1, 0), None);
        assert_eq!(checked_mul_div(0, 0, 0), None);
    }

    #[test]
    fn mul_div_remainder_carry_path() {
        // Divisors above 2^127 push the shifted remainder past 128 bits.
        let half = 1u128 << 127;
        let cases = [
            (MAX, MAX - 1, MAX),
            (MAX, MAX - 2, MAX - 1),
            (MAX - 1, MAX - 1, MAX),
            (MAX, half + 5, half + 7),
            (half + 1, half + 1, MAX),
            (MAX, half, half + 1),
            (MAX - 12345, MAX - 99999, MAX - 7),
            (MAX, MAX, MAX),
            (half + 1, half, half + 1),
        ];
        for (a, b, c) in cases {
            let got = checked_mul_div(a, b, c);
            assert_eq!(got, ref_mul_div(a, b, c), "a={a} b={b} c={c}");
            let q = got.expect("these cases fit");
            assert_floor(a, b, c, q);
        }
    }

    #[test]
    #[should_panic(expected = "mul_div")]
    fn mul_div_panics_on_zero_divisor() {
        mul_div(1, 1, 0);
    }

    #[test]
    #[should_panic(expected = "mul_div")]
    fn mul_div_panics_on_overflow() {
        mul_div(MAX, MAX, 1);
    }

    #[test]
    fn mul_div_matches_native_when_product_fits() {
        let mut rng = Rng(0xDEAD_BEEF_CAFE_F00D);
        for _ in 0..50_000 {
            let a = rng.next_u64() as u128;
            let b = rng.next_u64() as u128;
            let c = (rng.sized() >> 32).max(1);
            assert_eq!(mul_div(a, b, c), a * b / c);
        }
    }

    #[test]
    fn mul_div_matches_reference_random() {
        let mut rng = Rng(0x1234_5678_9ABC_DEF1);
        let mut some = 0u32;
        let mut none = 0u32;
        for _ in 0..30_000 {
            let a = rng.sized();
            let b = rng.sized();
            let c = rng.sized();
            let got = checked_mul_div(a, b, c);
            let want = ref_mul_div(a, b, c);
            assert_eq!(got, want, "a={a} b={b} c={c}");
            match got {
                Some(q) => {
                    assert_floor(a, b, c, q);
                    some += 1;
                }
                None => none += 1,
            }
        }
        // Both outcomes must be exercised.
        assert!(some > 1_000, "some={some}");
        assert!(none > 1_000, "none={none}");
    }

    #[test]
    fn mul_div_matches_reference_large_operands() {
        // Full-width operands with a divisor at least as large as one of
        // them, so the result fits and the long-division path runs.
        let mut rng = Rng(0x0BAD_5EED_0BAD_5EED);
        for _ in 0..20_000 {
            let a = rng.next_u128() | (1 << 127);
            let b = rng.next_u128();
            let c = rng.next_u128().max(b).max(1);
            let q = checked_mul_div(a, b, c).expect("b <= c so the result fits");
            assert_eq!(Some(q), ref_mul_div(a, b, c), "a={a} b={b} c={c}");
            assert_floor(a, b, c, q);
            assert!(q <= a);
        }
    }

    // Pool

    const E18: u128 = 1_000_000_000_000_000_000;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn buy_out_basic() {
        // 950M tokens, 100 NEAR virtual, buy with 100 NEAR -> half the pool.
        let t = 950_000_000 * E18;
        assert_eq!(buy_out(t, 100 * NEAR, 100 * NEAR), Some(t / 2));
        assert_eq!(buy_out(t, 100 * NEAR, 0), Some(0));
        assert_eq!(buy_out(0, 100 * NEAR, NEAR), Some(0));
        // Zero reserve and zero input: denominator is zero.
        assert_eq!(buy_out(t, 0, 0), None);
        // Reserve + input overflows.
        assert_eq!(buy_out(t, MAX, 1), None);
        // Largest supply and reserve allowed by the contract, huge deposit.
        let t = 1_000_000_000_000 * E18;
        let r = 1_000_000 * NEAR;
        let out = buy_out(t, r, MAX - r).unwrap();
        assert!(out < t);
    }

    #[test]
    fn sell_out_basic() {
        let t = 475_000_000 * E18;
        let r = 200 * NEAR;
        // Selling as many tokens as the pool holds returns half the reserve.
        assert_eq!(sell_out(t, r, t), Some(r / 2));
        assert_eq!(sell_out(t, r, 0), Some(0));
        assert_eq!(sell_out(0, r, 0), None);
        assert_eq!(sell_out(MAX, r, 1), None);
    }

    #[test]
    fn buy_then_sell_never_profits() {
        let mut rng = Rng(0xA5A5_5A5A_1234_4321);
        for _ in 0..20_000 {
            let t = 1_000_000 * E18 + rng.next_u128() % (1_000_000_000_000 * E18);
            let virt = NEAR / 10 + rng.next_u128() % (1_000_000 * NEAR);
            let pool_near = rng.next_u128() % (1_000_000 * NEAR);
            let n = 1 + rng.next_u128() % (1_000_000 * NEAR);
            let r = virt + pool_near;
            let out = buy_out(t, r, n).unwrap();
            assert!(out < t);
            if out == 0 {
                continue;
            }
            // State after the buy.
            let t2 = t - out;
            let r2 = r + n;
            let back = sell_out(t2, r2, out).unwrap();
            assert!(back <= n, "round trip gained NEAR: n={n} back={back}");
            // The constant product never decreases on a buy.
            assert!(mul_wide(t2, r2) >= mul_wide(t, r));
        }
    }

    #[test]
    fn sell_in_pieces_never_returns_more() {
        let mut rng = Rng(0x7777_1111_3333_9999);
        for _ in 0..20_000 {
            let t = 1_000_000 * E18 + rng.next_u128() % (1_000_000_000 * E18);
            let r = NEAR + rng.next_u128() % (100_000 * NEAR);
            let x = 2 + rng.next_u128() % (10_000_000 * E18);
            let x1 = 1 + rng.next_u128() % (x - 1);
            let x2 = x - x1;
            let whole = sell_out(t, r, x).unwrap();
            let first = sell_out(t, r, x1).unwrap();
            let second = sell_out(t + x1, r - first, x2).unwrap();
            assert!(first + second <= whole, "split sale returned more");
        }
    }

    #[test]
    fn max_sell_edges() {
        let t = 950_000_000 * E18;
        // An empty pool can pay for nothing.
        assert_eq!(max_sell(t, 100 * NEAR, 0), 0);
        // pool_near == virtual_near: selling `t` returns half of the reserve.
        assert_eq!(max_sell(t, 100 * NEAR, 100 * NEAR), t);
        assert_eq!(sell_out(t, 200 * NEAR, t), Some(100 * NEAR));
        assert_eq!(max_sell(t, 0, NEAR), MAX);
        assert_eq!(max_sell(MAX, 1, MAX), MAX);
    }

    #[test]
    fn max_sell_is_always_payable() {
        let mut rng = Rng(0x0DD5_EA75_600D_F00D);
        let mut clamped = 0u32;
        for _ in 0..20_000 {
            let t = 1_000_000 * E18 + rng.next_u128() % (1_000_000_000_000 * E18);
            let virt = NEAR / 10 + rng.next_u128() % (1_000_000 * NEAR);
            let pool_near = rng.sized() % (1_000_000 * NEAR);
            let x = max_sell(t, virt, pool_near);
            let r = virt + pool_near;
            let out = sell_out(t, r, x).unwrap();
            assert!(out <= pool_near, "max_sell is not payable: {out} > {pool_near}");
            // It is tight: the pool cannot pay for two units more.
            if sell_out(t, r, x + 2).unwrap() > pool_near {
                clamped += 1;
            }
            // Anything smaller is payable too.
            if x > 0 {
                let smaller = rng.next_u128() % x;
                assert!(sell_out(t, r, smaller).unwrap() <= pool_near);
            }
        }
        assert!(clamped > 0);
    }

    // Basis points

    #[test]
    fn bps_part_rounds_down() {
        assert_eq!(bps_part(0, 100), 0);
        assert_eq!(bps_part(NEAR, 0), 0);
        // 1%: the first whole unit appears at 100.
        assert_eq!(bps_part(99, 100), 0);
        assert_eq!(bps_part(100, 100), 1);
        assert_eq!(bps_part(199, 100), 1);
        assert_eq!(bps_part(200, 100), 2);
        assert_eq!(bps_part(25 * NEAR, 100), NEAR / 4);
        // One basis point.
        assert_eq!(bps_part(9_999, 1), 0);
        assert_eq!(bps_part(10_000, 1), 1);
        // The whole amount, and nothing more above 10_000.
        assert_eq!(bps_part(MAX, 10_000), MAX);
        assert_eq!(bps_part(MAX, 10_001), MAX);
        assert_eq!(bps_part(MAX, MAX), MAX);
        // The 256-bit intermediate keeps large amounts exact.
        assert_eq!(bps_part(MAX, 100), MAX / 100);
        assert_eq!(bps_part(MAX, 5_000), MAX / 2);
    }

    #[test]
    fn pro_rata_ceil_rounds_up() {
        assert_eq!(pro_rata_ceil(0, 1, 2), 0);
        assert_eq!(pro_rata_ceil(10, 0, 5), 0);
        assert_eq!(pro_rata_ceil(10, 5, 5), 10);
        assert_eq!(pro_rata_ceil(10, 1, 3), 4);
        assert_eq!(pro_rata_ceil(9, 1, 3), 3);
        assert_eq!(pro_rata_ceil(1, 1, 1_000_000), 1);
        assert_eq!(pro_rata_ceil(NEAR, 1, 3), NEAR / 3 + 1);
        // A part above the whole counts as the whole.
        assert_eq!(pro_rata_ceil(10, 7, 5), 10);
        // No whole, no share.
        assert_eq!(pro_rata_ceil(10, 1, 0), 0);
        // The 256-bit intermediate keeps large values exact.
        assert_eq!(pro_rata_ceil(MAX, MAX, MAX), MAX);
        assert_eq!(pro_rata_ceil(MAX, 1, 2), MAX / 2 + 1);
        assert_eq!(pro_rata_ceil(MAX - 1, 1, 2), MAX / 2);
    }

    #[test]
    fn pro_rata_ceil_is_the_ceiling_and_pieces_cover_the_total() {
        let mut rng = Rng(0xCA7C_F100_0D5E_ED01);
        for _ in 0..20_000 {
            let total = rng.sized();
            let whole = rng.sized();
            if whole == 0 {
                continue;
            }
            let part = rng.sized() % (whole + 1);
            let up = pro_rata_ceil(total, part, whole);
            let down = ref_mul_div(total, part, whole).unwrap();
            assert!(up <= total);
            assert!(up == down || up == down + 1, "{total} {part} {whole}");
            // Exact when the division has no remainder, one above otherwise.
            let exact = big_cmp(&big_mul(down, whole), &big_mul(total, part)) == Ordering::Equal;
            assert_eq!(up == down, exact, "{total} {part} {whole}");
            // Two pieces never cost less than the whole.
            let rest = pro_rata_ceil(total, whole - part, whole);
            assert!(up.checked_add(rest).map_or(true, |sum| sum >= total));
        }
    }

    #[test]
    fn bps_part_never_exceeds_the_amount() {
        let mut rng = Rng(0xB125_0F00_CA7C_4FEE);
        for _ in 0..20_000 {
            let amount = rng.sized();
            let bps = rng.next_u64() as u128 % 12_000;
            let part = bps_part(amount, bps);
            assert!(part <= amount);
            let capped = if bps > 10_000 { 10_000 } else { bps };
            assert_eq!(Some(part), ref_mul_div(amount, capped, 10_000));
            // More basis points never take less.
            assert!(bps_part(amount, bps + 1) >= part);
        }
    }

    // Bucket

    const WINDOW: u64 = 3_600_000_000_000;
    const CAP: u128 = 5_000_000 * E18;

    #[test]
    fn bucket_gain_edges() {
        assert_eq!(bucket_gain(CAP, WINDOW, 0), 0);
        assert_eq!(bucket_gain(CAP, WINDOW, WINDOW), CAP);
        assert_eq!(bucket_gain(CAP, WINDOW, WINDOW / 2), CAP / 2);
        assert_eq!(bucket_gain(CAP, WINDOW, u64::MAX), CAP);
        // The largest cap does not overflow.
        assert_eq!(
            bucket_gain(MAX, WINDOW, WINDOW - 1),
            mul_div(MAX, (WINDOW - 1) as u128, WINDOW as u128)
        );
        assert_eq!(
            bucket_gain(MAX, u64::MAX, u64::MAX - 1),
            mul_div(MAX, (u64::MAX - 1) as u128, u64::MAX as u128)
        );
    }

    #[test]
    fn bucket_starts_empty_and_fills_linearly() {
        let t0 = 1_000;
        assert_eq!(bucket_available(CAP, WINDOW, 0, t0, t0), 0);
        assert_eq!(bucket_available(CAP, WINDOW, 0, t0, t0 + WINDOW / 4), CAP / 4);
        assert_eq!(bucket_available(CAP, WINDOW, 0, t0, t0 + WINDOW), CAP);
        assert_eq!(bucket_available(CAP, WINDOW, 0, t0, t0 + 10 * WINDOW), CAP);
        // Time going backwards changes nothing.
        assert_eq!(bucket_available(CAP, WINDOW, 7, t0, t0 - 1), 7);
        assert_eq!(bucket_refill(CAP, WINDOW, 7, t0, t0 - 1), (7, t0));
    }

    #[test]
    fn bucket_refill_matches_available() {
        let mut rng = Rng(0x4242_4242_1717_1717);
        for _ in 0..20_000 {
            let cap = 1 + rng.sized() % (1u128 << 100);
            let window = 1 + rng.next_u64() % (7 * 24 * WINDOW);
            let units = rng.next_u128() % (cap + 1);
            let ts = rng.next_u64() % (1 << 62);
            let now = ts + rng.next_u64() % (2 * window);
            let avail = bucket_available(cap, window, units, ts, now);
            let (u2, ts2) = bucket_refill(cap, window, units, ts, now);
            assert_eq!(u2, avail);
            assert!(avail <= cap);
            assert!(avail >= units);
            assert!(ts2 == now || (ts2 == ts && u2 == units));
        }
    }

    #[test]
    fn bucket_keeps_fractions_when_nothing_was_added() {
        // 1 unit per 1000 ns. bucket_ts must not move while add == 0.
        let cap = 10u128;
        let window = 10_000u64;
        assert_eq!(bucket_refill(cap, window, 0, 0, 999), (0, 0));
        assert_eq!(bucket_refill(cap, window, 0, 0, 1_000), (1, 1_000));
        // Calls every 300 ns: 0 at 300, 600, 900; 1 unit at 1200 (ts moves).
        let (mut units, mut ts) = (0u128, 0u64);
        let mut now = 0u64;
        let mut seen = [0u128; 4];
        for slot in seen.iter_mut() {
            now += 300;
            let r = bucket_refill(cap, window, units, ts, now);
            units = r.0;
            ts = r.1;
            *slot = units;
        }
        assert_eq!(seen, [0, 0, 0, 1]);
        assert_eq!(ts, 1_200);
    }

    #[test]
    fn bucket_total_outflow_is_bounded() {
        // Whatever the call pattern, units taken over [t0, t1] never exceed
        // bucket(t0) + cap * (t1 - t0) / window.
        let mut rng = Rng(0x5151_AAAA_0F0F_F0F0);
        for round in 0..300 {
            let cap = 1 + rng.sized() % (1u128 << 90);
            let window = 60 + rng.next_u64() % WINDOW;
            let t0 = rng.next_u64() % (1 << 40);
            let start = rng.next_u128() % (cap + 1);
            let (mut units, mut ts) = (start, t0);
            let mut now = t0;
            let mut taken: u128 = 0;
            for _ in 0..200 {
                now += rng.next_u64() % (window / 8 + 1);
                let r = bucket_refill(cap, window, units, ts, now);
                units = r.0;
                ts = r.1;
                // Take everything, a random part, or nothing.
                let take = match rng.next_u64() % 3 {
                    0 => units,
                    1 => rng.next_u128() % (units + 1),
                    _ => 0,
                };
                units -= take;
                taken += take;
                let elapsed = (now - t0) as u128;
                let refill = checked_mul_div(cap, elapsed, window as u128).unwrap_or(MAX);
                let bound = start.saturating_add(refill);
                assert!(taken <= bound, "round {round}: taken {taken} > bound {bound}");
            }
        }
    }

    #[test]
    fn bucket_wait_ns_is_the_first_moment_with_room() {
        assert_eq!(bucket_wait_ns(CAP, WINDOW, 0), 0);
        assert_eq!(bucket_wait_ns(CAP, WINDOW, CAP), WINDOW);
        assert_eq!(bucket_wait_ns(CAP, WINDOW, CAP * 3), WINDOW);
        assert_eq!(bucket_wait_ns(CAP, WINDOW, CAP / 2), WINDOW / 2);
        let mut rng = Rng(0x3141_5926_5358_9793);
        for _ in 0..20_000 {
            let cap = 1 + rng.sized() % (1u128 << 100);
            let window = 1 + rng.next_u64() % (7 * 24 * WINDOW);
            let want = 1 + rng.next_u128() % cap;
            let wait = bucket_wait_ns(cap, window, want);
            assert!(wait <= window);
            assert!(bucket_gain(cap, window, wait) >= want);
            if wait > 0 {
                assert!(bucket_gain(cap, window, wait - 1) < want);
            }
        }
    }
}
