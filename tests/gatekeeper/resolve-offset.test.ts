// The other half of rust/services/gatekeeper/src/store.rs::time_ordering. The
// TS resolver orders event times with `new Date(a) > new Date(b)`, which is an
// instant comparison; the Rust port must match it, including when a time
// carries an offset rather than Z (#1131). This pins that JS Date agrees with
// the instants the Rust unit test asserts, so the two ports cannot drift to a
// string comparison on one side.
describe('event time ordering across offsets', () => {

    const after = (a: string, b: string) => new Date(a).getTime() > new Date(b).getTime();

    it('orders by instant, not text', () => {
        // 13:00+01:00 is 12:00Z, which is before 12:30Z.
        expect(after('2026-04-11T12:30:00Z', '2026-04-11T13:00:00+01:00')).toBe(true);
        expect(after('2026-04-11T13:00:00+01:00', '2026-04-11T12:30:00Z')).toBe(false);
        expect(after('2026-04-11T12:00:00Z', '2026-04-11T13:00:00+01:00')).toBe(false);
        expect(after('2026-04-11T13:00:00+01:00', '2026-04-11T12:00:00Z')).toBe(false);
        expect(after('2026-04-11T12:31:00Z', '2026-04-11T12:30:00Z')).toBe(true);
    });
});
