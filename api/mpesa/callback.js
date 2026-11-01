
async function dbRequest(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL;

  if (!key || !url) {
    throw new Error("Missing Supabase server environment variables.");
  }

  const response = await fetch(
    url.replace(/\/$/, "") + path,
    {
      ...options,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const callback =
      req.body &&
      req.body.Body &&
      req.body.Body.stkCallback;

    if (
      !callback ||
      !callback.CheckoutRequestID ||
      typeof callback.ResultCode !== "number"
    ) {
      return res.status(400).json({ error: "Invalid callback data" });
    }

    // Find the pending payment using Safaricom's checkout ID.
    const checkoutId = encodeURIComponent(callback.CheckoutRequestID);

    const payments = await dbRequest(
      "/rest/v1/payments?checkout_request_id=eq." +
      checkoutId +
      "&select=id,amount,phone,status"
    );

    const payment = Array.isArray(payments) ? payments[0] : null;

    if (!payment) {
      return res.status(200).json({
        received: true,
        matched: false
      });
    }

    // Do not process the same payment twice.
    if (payment.status === "confirmed" || payment.status === "failed") {
      return res.status(200).json({
        received: true,
        alreadyProcessed: true
      });
    }

    let update;

    if (callback.ResultCode === 0) {
      const items =
        callback.CallbackMetadata &&
        Array.isArray(callback.CallbackMetadata.Item)
          ? callback.CallbackMetadata.Item
          : [];

      function getValue(name) {
        const item = items.find(x => x.Name === name);
        return item ? item.Value : null;
      }

      const paidAmount = Number(getValue("Amount"));
      const receipt = getValue("MpesaReceiptNumber");
      const paidPhone = String(getValue("PhoneNumber") || "");

      const expectedPhone = String(payment.phone || "")
        .replace(/^0/, "254");

      const phoneMatches =
        paidPhone === expectedPhone ||
        ("0" + paidPhone.slice(3)) === String(payment.phone || "");

      // Verify the actual amount, receipt and phone number.
      if (
        paidAmount !== Number(payment.amount) ||
        !receipt ||
        !phoneMatches
      ) {
        console.error("Payment verification mismatch:", callback.CheckoutRequestID);

        return res.status(200).json({
          received: true,
          confirmed: false,
          reason: "Payment details did not match."
        });
      }

      update = {
        status: "confirmed",
        mpesa_receipt: String(receipt)
      };

    } else {
      update = {
        status: "failed"
      };
    }

    // Update only a payment that is still pending.
    await dbRequest(
      "/rest/v1/payments?id=eq." +
      encodeURIComponent(payment.id) +
      "&status=eq.pending",
      {
        method: "PATCH",
        body: JSON.stringify(update)
      }
    );

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("M-Pesa callback error:", error);

    return res.status(500).json({
      error: "Callback processing failed."
    });
  }
};
