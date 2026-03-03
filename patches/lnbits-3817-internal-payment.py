"""
Apply fix for internal payment balance zeroing (lnbits/lnbits#3817).

Wraps the funding-source status check in `if not is_internal:` so that
internal payments skip the CLN round-trip that zeros balance/preimage.
"""
import sys

TASKS_FILE = "/app/lnbits/tasks.py"

OLD = """\
    from lnbits.core.services.payments import check_payment_status

    status = await check_payment_status(
        payment, skip_internal_payment_notifications=True
    )
    payment.fee = status.fee_msat or payment.fee
    # only overwrite preimage if status.preimage provides it
    payment.preimage = status.preimage or payment.preimage
    payment.status = PaymentState.SUCCESS"""

NEW = """\
    if not is_internal:
        from lnbits.core.services.payments import check_payment_status

        status = await check_payment_status(
            payment, skip_internal_payment_notifications=True
        )
        payment.fee = status.fee_msat or payment.fee
        # only overwrite preimage if status.preimage provides it
        payment.preimage = status.preimage or payment.preimage
    payment.status = PaymentState.SUCCESS"""

with open(TASKS_FILE) as f:
    content = f.read()

if OLD not in content:
    print("ERROR: Patch target not found — LNbits version may have changed", file=sys.stderr)
    sys.exit(1)

with open(TASKS_FILE, "w") as f:
    f.write(content.replace(OLD, NEW))

print("[lnbits] Patch #3817 applied successfully")
