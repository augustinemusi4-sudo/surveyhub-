
const crypto = require("crypto");

function getEnv(name) {
  if (!process.env[name]) throw new Error("Missing environment variable: " + name);
  return process.env[name];
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/[\s+()-]/g, "");

  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  if (phone.startsWith("7") || phone.startsWith("1")) phone = "254" + phone;

  if (!/^254[17]\d{8}$/.test(phone)) {
    throw new Error("Enter a valid Kenyan phone number, e.g. 0712345678.");
  }

  return phone;
}

function getTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = {};
  parts.forEach(part => values[part.type] = part.value);

  return values.year + values.month + values.day +
    values.hour + values.minute + values.second;
}

async function supabaseRequest(path, options = {}) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(
    getEnv("SUPABASE_URL").replace(/\/$/, "") + path,
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

  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Verify the logged-in Supabase user.
    const authorization = req.headers.authorization || "";
    const userToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!userToken) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const supabaseUrl = getEnv("SUPABASE_URL").replace(/\/$/, "");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userResponse = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + userToken
      }
    });

    const user = await userResponse.json();

    if (!userResponse.ok || !user.id) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }

    const phone = normalizePhone(req.body && req.body.phone);
    const amount = 50;

    // Select Daraja environment.
    const production = getEnv("DARAJA_ENVIRONMENT") === "production";
    const host = production
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    // Get Daraja access token.
    const credentials = Buffer.from(
      getEnv("DARAJA_CONSUMER_KEY") + ":" +
      getEnv("DARAJA_CONSUMER_SECRET")
    ).toString("base64");

    const tokenResponse = await fetch(
      host + "/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: { Authorization: "Basic " + credentials }
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error("Could not authenticate with M-Pesa Daraja.");
    }

    const shortcode = getEnv("DARAJA_SHORTCODE");
    const timestamp = getTimestamp();

    const password = Buffer.from(
      shortcode + getEnv("DARAJA_PASSKEY") + timestamp
    ).toString("base64");

    // Create pending payment record.
    const pending = await supabaseRequest("/rest/v1/payments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        user_id: user.id,
        amount: amount,
        phone: phone,
        status: "pending"
      }])
    });

    const payment = Array.isArray(pending) ? pending[0] : null;

    if (!payment) {
      throw new Error("Could not create payment record.");
    }

    // Send STK Push.
    const callbackUrl =
      "https://" + req.headers.host + "/api/mpesa/callback";

    const stkResponse = await fetch(
      host + "/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: amount,
          PartyA: phone,
          PartyB: shortcode,
          PhoneNumber: phone,
          CallBackURL: callbackUrl,
          AccountReference: "SurveyHub",
          TransactionDesc: "SurveyHub membership"
        })
      }
    );

    const result = await stkResponse.json();

    if (!stkResponse.ok ||
        result.ResponseCode !== "0" ||
        !result.CheckoutRequestID) {

      await supabaseRequest(
        "/rest/v1/payments?id=eq." + encodeURIComponent(payment.id),
        {
          method: "PATCH",
          body: JSON.stringify({ status: "failed" })
        }
      );

      return res.status(502).json({
        error: result.errorMessage ||
          result.ResponseDescription ||
          "M-Pesa could not start the payment."
      });
    }

    // Save the checkout request ID for the callback.
    await supabaseRequest(
      "/rest/v1/payments?id=eq." + encodeURIComponent(payment.id),
      {
        method: "PATCH",
        body: JSON.stringify({
          checkout_request_id: result.CheckoutRequestID
        })
      }
    );

    return res.status(200).json({
      success: true,
      message: "STK Push sent. Check your phone and enter your M-Pesa PIN.",
      checkoutRequestId: result.CheckoutRequestID
    });

  } catch (error) {
    console.error("STK Push error:", error);

    return res.status(500).json({
      error: error.message || "Payment request failed."
    });
  }
};
