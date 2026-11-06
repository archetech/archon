"""Cashu wallet scenarios against real Lightning. Run by run.sh, which starts the stack."""

import hashlib
import json
import os
import re
import subprocess
import sys
import time

os.chdir(os.path.dirname(os.path.abspath(__file__)))

COMPOSE = ["docker", "compose", "-p", "cashu-regtest", "-f", "compose.yml"]
RPC = "/data/lightning/regtest/regtest/lightning-rpc"
FLAVORS = ("keymaster-py", "keymaster-ts")

failures = []
known = []


def check(passed, what):
    print(f"  {'ok' if passed else 'FAIL'} {what}", flush=True)
    if not passed:
        failures.append(what)


def section(title):
    print(f"=== {title}", flush=True)


def run(*args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def compose(*args, timeout=180):
    return run(*COMPOSE, *args, timeout=timeout)


def ln(node, *args):
    result = compose("exec", "-T", node, "lightning-cli", f"--rpc-file={RPC}", *args)
    if result.returncode:
        sys.exit(f"lightning-cli {node} {args}: {result.stderr or result.stdout}")
    # `pay` prints progress lines ahead of its JSON.
    return json.loads("\n".join(line for line in result.stdout.splitlines() if not line.startswith("#")))


def until(condition, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(1)
    return None


class Wallet:
    def __init__(self, service, name):
        self.service, self.name = service, name

    def command(self, *args):
        return [*COMPOSE, "exec", "-T", "-e", f"ARCHON_KEYMASTER_URL=http://{self.service}:4226",
                "cli", "node", "scripts/archon-cli.js", *args]

    def cli(self, *args, check_exit=True, timeout=120):
        result = run(*self.command(*args), timeout=timeout)
        if check_exit and result.returncode:
            sys.exit(f"[{self.service}] {args}\nOUT {result.stdout[:400]}\nERR {result.stderr[-500:]}")
        return result

    def json(self, *args, timeout=120):
        return json.loads(self.cli(*args, timeout=timeout).stdout)

    def balance(self):
        return self.json("cashu-balance", self.name)

    def lightning_balance(self):
        return int(re.search(r"(-?\d+)", self.cli("lightning-balance", self.name).stdout).group(1))

    def did(self):
        return self.json("resolve-did", self.name)["didDocument"]["id"]

    def open_quote(self):
        melts = [quote for quote in self.json("cashu-quotes", self.name) if quote["kind"] == "melt"]
        return melts[0]["quote"] if melts else None

    def settle(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            self.cli("cashu-check", self.name, check_exit=False, timeout=90)
            balance = self.balance()
            if balance["inFlight"] == 0:
                return balance
            time.sleep(1)
        return None


def mint_says(quote):
    """The mint's own state for a melt quote. It may not answer at all while a payment
    is in flight, so the wait is bounded."""
    if not quote:
        return None
    lookup = (f"fetch('http://cashu-mint:8085/v1/melt/quote/bolt11/{quote}', {{ signal: AbortSignal.timeout(8000) }})"
              ".then(r => r.json()).then(j => console.log(j.state)).catch(() => console.log('NO ANSWER'))")
    return compose("exec", "-T", "cli", "node", "-e", lookup).stdout.strip()


def invoice(node, sats, tag):
    label = f"{tag}-{time.time()}"
    return ln(node, "invoice", str(sats * 1000), label, tag), label


def paid(node, label):
    return ln(node, "listinvoices", f"label={label}")["invoices"][0]["status"] == "paid"


def node_says(bolt):
    for payment in ln("cln-mint", "listpays")["pays"]:
        if payment["payment_hash"] == bolt["payment_hash"]:
            return payment["status"]
    return None


def check_routing_fee(bolt, fee):
    """Against what the mint's node paid. The wallet works out its fee from the change
    it got back, so its own figure counts missing change as fee. The mint charges whole
    sats, rounded up."""
    payment = next(item for item in ln("cln-mint", "listpays")["pays"]
                   if item["payment_hash"] == bolt["payment_hash"] and item["status"] == "complete")
    routing = payment["amount_sent_msat"] - payment["amount_msat"]
    check(fee == (routing + 999) // 1000, f"the fee of {fee} is what the route cost: {routing} msat")


def payee_shell(command):
    compose("exec", "-T", "cln-payee", "sh", "-c", command)


def hold(fail=False):
    payee_shell("touch /tmp/hold" + (" /tmp/hold-fail" if fail else ""))


def release():
    payee_shell("rm -f /tmp/hold")


def stop_holding():
    payee_shell("rm -f /tmp/hold /tmp/hold-fail")


def wait_for_payee(bolt):
    """The wallet records its proofs as in flight before it submits the melt, so that
    says nothing about the payment having left."""
    arrived = f"/tmp/htlc-{bolt['payment_hash']}"
    if not until(lambda: compose("exec", "-T", "cln-payee", "test", "-e", arrived).returncode == 0):
        sys.exit(f"the payment {bolt['payment_hash']} never reached the payee")


def start_melt(wallet, bolt):
    return subprocess.Popen(wallet.command("cashu-melt", bolt["bolt11"], wallet.name),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def forget_routes():
    """A failed payment leaves xpay a learned limit on the channel, which lasts and
    refuses larger payments over it, so each scenario starts without any."""
    ln("cln-mint", "askrene-age", "xpay", str(int(time.time()) + 5))


def route_is_up():
    def probe():
        bolt, _ = invoice("cln-payee", 1, "probe")
        result = compose("exec", "-T", "cln-mint", "lightning-cli", f"--rpc-file={RPC}", "pay", bolt["bolt11"])
        return result.returncode == 0 and '"complete"' in result.stdout

    return until(probe, 180)


created = [0]


def new_wallet(service, sats):
    """A wallet of its own for each scenario, so one that leaves value stuck cannot
    affect the next."""
    forget_routes()
    created[0] += 1
    name = f"w{created[0]}"
    wallet = Wallet(service, name)
    wallet.cli("create-id", "-r", "local", name)
    wallet.cli("publish-didcomm", "-n", name)
    wallet.cli("add-cashu", name)
    wallet.cli("publish-cashu", name)
    quote = wallet.json("cashu-mint", str(sats), name)
    ln("cln-user", "pay", quote["request"])
    claim(wallet, quote)
    return wallet


def claim(wallet, quote):
    def attempt():
        result = wallet.cli("cashu-claim", quote["quote"], wallet.name, check_exit=False)
        return json.loads(result.stdout) if result.returncode == 0 else None

    return until(attempt, 30)


def lightning_wallet(service):
    created[0] += 1
    name = f"w{created[0]}"
    wallet = Wallet(service, name)
    wallet.cli("create-id", "-r", "local", name)
    wallet.cli("publish-didcomm", "-n", name)
    wallet.cli("add-cashu", name)
    wallet.cli("add-lightning", name)
    bill = wallet.json("lightning-invoice", "60000", "float", name)
    check(ln("cln-mint", "pay", bill["paymentRequest"])["status"] == "complete", "funded with a real Lightning payment")
    check(until(lambda: wallet.lightning_balance() >= 60000, 30) is not None, "the Lightning wallet shows it")
    return wallet


def mint_with_pay(service):
    section(f"{service}: cashu-mint --pay from the Lightning wallet")
    wallet = lightning_wallet(service)
    before = wallet.lightning_balance()
    minted = wallet.json("cashu-mint", "20000", wallet.name, "--pay")
    check(minted["amount"] == 20000 and minted["balance"]["spendable"] == 20000, f"minted {minted['amount']}")
    check(until(lambda: wallet.lightning_balance() <= before - 20000, 20) is not None, "the Lightning wallet paid for it")
    invoices = ln("cln-mint", "listinvoices")["invoices"]
    check(any(item["status"] == "paid" and item.get("amount_msat") == 20000000 for item in invoices), "the mint's node shows it paid")

    section(f"{service}: cashu-mint --pay with too little in the Lightning wallet")
    balance = wallet.lightning_balance()
    refused = wallet.cli("cashu-mint", str(balance + 1000), wallet.name, "--pay", check_exit=False)
    check(refused.returncode == 1, "refused")
    check("Paying Cashu quote" in refused.stderr, "the quote is named, so it can be finished")
    check("[object Object]" not in refused.stderr and "developer.mozilla.org" not in refused.stderr, "the reason is readable")
    check(wallet.lightning_balance() == balance, "the Lightning wallet is untouched")


def claim_only_once_paid(service):
    section(f"{service}: a claim waits for the payment")
    wallet = new_wallet(service, 1000)
    quote = wallet.json("cashu-mint", "500", wallet.name)
    early = wallet.cli("cashu-claim", quote["quote"], wallet.name, check_exit=False)
    check(early.returncode == 1 and "not paid" in early.stderr, "refused while unpaid")
    ln("cln-user", "pay", quote["request"])
    claimed = claim(wallet, quote)
    check(bool(claimed) and claimed["balance"]["spendable"] == 1500, "claimed once paid")
    check(wallet.json("cashu-quotes", wallet.name) == [], "no quote left open")


def melt_over_a_route(service):
    section(f"{service}: melt over a real route")
    wallet = new_wallet(service, 16000)
    bolt, label = invoice("cln-payee", 2000, "melt")
    melted = wallet.json("cashu-melt", bolt["bolt11"], wallet.name)
    check(melted["paid"] is True and paid("cln-payee", label), "paid, and the payee node agrees")
    check(hashlib.sha256(bytes.fromhex(melted["preimage"])).hexdigest() == bolt["payment_hash"], "the preimage hashes to the payment hash")
    check_routing_fee(bolt, melted["fee"])
    check(16000 - melted["balance"]["spendable"] == 2000 + melted["fee"], "spent exactly the amount plus the fee")
    check(melted["balance"]["inFlight"] == 0, "nothing left in flight")


def held_melt_survives_a_crash(service):
    section(f"{service}: a payment in flight while Keymaster is killed, which then succeeds")
    wallet = new_wallet(service, 16000)
    bolt, label = invoice("cln-payee", 1500, "pending")
    hold()
    melt = start_melt(wallet, bolt)
    try:
        wait_for_payee(bolt)
        # 1500 plus the reserve fits one 2048 proof of the 16000 balance.
        check(wallet.balance()["inFlight"] == 2048, "held at the payee, locking only the proof that covers it")
        compose("kill", service)
        compose("start", service)
        until(lambda: wallet.cli("cashu-balance", wallet.name, check_exit=False).returncode == 0, 120)
        after = wallet.json("cashu-check", wallet.name, timeout=120)
        check(after["open"] >= 1 and after["balance"]["inFlight"] > 0, "after the crash it is still open and in flight")
        release()
        check(until(lambda: paid("cln-payee", label)) is not None, "released: the payee is paid")
        settled = wallet.settle(120)
        check(bool(settled), "settled by cashu-check")
        if settled:
            spent = 16000 - settled["spendable"]
            check(spent > 1500, f"spent {spent}: the amount and a fee, with the change returned")
            check_routing_fee(bolt, spent - 1500)
        check(wallet.json("cashu-quotes", wallet.name) == [], "nothing left open")
    finally:
        melt.kill()
        stop_holding()


def expect_stuck(wallet, bolt, quote, description, sats):
    """cdk#2836: the mint keeps a payment that failed after being attempted PENDING.
    Nothing short of that is excused, and the wallet's word is not taken for a fix."""
    attempted = until(lambda: node_says(bolt) == "failed", 30)
    check(bool(attempted), "the mint's node tried the payment and it failed")
    settled = wallet.settle(60)
    state = mint_says(quote)
    print(f"   the mint says {state}", flush=True)
    balance = settled or wallet.balance()
    check(balance["spendable"] + balance["inFlight"] == sats, f"no value vanished: {balance}")
    if settled:
        check(state == "UNPAID", "the mint itself says the quote is released")
        print(f"   NOTE: the mint released this. cdk#2836 may be fixed: {description}", flush=True)
    elif attempted and state == "PENDING":
        known.append(f"cdk#2836: {description}")
        print(f"   KNOWN ISSUE cdk#2836: still in flight ({description})", flush=True)
    else:
        check(False, f"still in flight, and not as cdk#2836 leaves it: {description}")
    return bool(settled)


def payee_rejects_a_held_melt(service):
    section(f"{service}: a payment in flight which the payee then rejects")
    wallet = new_wallet(service, 16000)
    bolt, _ = invoice("cln-payee", 700, "rejected")
    hold(fail=True)
    melt = start_melt(wallet, bolt)
    try:
        wait_for_payee(bolt)
        check(wallet.balance()["inFlight"] == 1024, "held at the payee, locking only the proof that covers it")
        quote = wallet.open_quote()
        release()
        if not expect_stuck(wallet, bolt, quote, "a rejected payment", 16000):
            compose("restart", "cashu-mint")
            time.sleep(6)
            expect_stuck(wallet, bolt, quote, "a rejected payment, after a mint restart", 16000)
    finally:
        melt.kill()
        stop_holding()


def payee_offline(service):
    section(f"{service}: a payee offline when the payment is tried")
    wallet = new_wallet(service, 16000)
    bolt, _ = invoice("cln-payee", 500, "offline")
    compose("stop", "cln-payee")
    melt = start_melt(wallet, bolt)
    try:
        # Read while the melt runs, since a mint that released it would leave none open.
        quote = until(wallet.open_quote, 30)
        until(lambda: melt.poll() is not None, 120)
        expect_stuck(wallet, bolt, quote, "an offline payee", 16000)
    finally:
        melt.kill()
        compose("start", "cln-payee")
        until(lambda: compose("exec", "-T", "cln-payee", "lightning-cli", f"--rpc-file={RPC}", "getinfo").returncode == 0, 60)
        ln("cln-hop", "connect", ln("cln-payee", "getinfo")["id"] + "@cln-payee:9736")
        check(bool(route_is_up()), "the route recovers once the payee is back")
        forget_routes()


def locked_send_then_melt():
    section("a locked send through the real relay, then melted over Lightning")
    typescript = new_wallet("keymaster-ts", 8000)
    python = new_wallet("keymaster-py", 8000)
    for sender, recipient in ((typescript, python), (python, typescript)):
        sent = sender.json("cashu-send-to", recipient.did(), "3000", "over the relay", sender.name)
        check(sent["delivered"] is True, f"{sender.service} to {recipient.service}: delivered")
        accepted = recipient.json("cashu-accept", recipient.name)
        check(accepted["failed"] == [] and accepted["redeemed"][0]["amount"] == 3000, f"{recipient.service} redeemed it")
        sender.cli("cashu-check", sender.name)
        check(sender.balance()["outstanding"] == 0, "the sender settled")
        bolt, label = invoice("cln-payee", 2500, "onward")
        melted = recipient.json("cashu-melt", bolt["bolt11"], recipient.name)
        check(melted["paid"] and paid("cln-payee", label), f"{recipient.service} melted the value received")


def main():
    stop_holding()
    forget_routes()
    if not route_is_up():
        sys.exit("no route to the payee at the start")
    for service in FLAVORS:
        mint_with_pay(service)
        claim_only_once_paid(service)
        melt_over_a_route(service)
        held_melt_survives_a_crash(service)
        payee_rejects_a_held_melt(service)
    locked_send_then_melt()
    for service in FLAVORS:
        payee_offline(service)

    if known:
        print(f"--- {len(known)} known, and no value lost:", *known, sep="\n  ")
    if failures:
        print("FAILED:", *failures, sep="\n  ")
        sys.exit(1)
    print("PASSED")


if __name__ == "__main__":
    main()
