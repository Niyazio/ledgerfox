import { describe, expect, it } from "vitest";
import { world } from "./helpers";

describe("print options", () => {
  it("QR codes on bills are optional and the choice is kept", async () => {
    const W = await world();
    const co = async () => (await W.owner.get(W.c("/settings"))).json.company;
    expect([(await co()).print_qr_verify, (await co()).print_qr_upi]).toEqual([1, 1]); // on by default, as before
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", print_qr_verify: false, print_qr_upi: false })).status).toBe(200);
    expect([(await co()).print_qr_verify, (await co()).print_qr_upi]).toEqual([0, 0]);
    // Saving other settings without these fields keeps the choice.
    await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29" });
    expect([(await co()).print_qr_verify, (await co()).print_qr_upi]).toEqual([0, 0]);
    await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", print_qr_upi: true });
    expect([(await co()).print_qr_verify, (await co()).print_qr_upi]).toEqual([0, 1]);
  });
});
