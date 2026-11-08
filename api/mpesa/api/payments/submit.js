function getEnv(name) {
  if (!process.env[name]) {
    throw new Error("Missing environment variable: " + name);
  }
  return process.env[name];
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/[\s+()-]/g, "");

  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("7") || phone.startsWith("1")) {
    phone = "254" + phone;
  }

  if (!/^254[17]\d{8}$/.test(phone)) {
    throw new Error("Enter a valid Kenyan phone number, such as 0712345678.");
  }

  return phone;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const supabaseUrl = getEnv("SUPABASE_URL").replace(/\/$/, "");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    const authorization = req.headers.authorization || "";
    const userToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!userToken) {
      return res.status(401).json({ error: "Please log in first." });
    }

    // Verify the member's Supabase login.
    const userResponse = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + userToken
      }
    });

    const user = await readResponse(userResponse);

    if (!userResponse.ok || !user || !user.id) {
      return res.status(401).json({
        error: "Your login session is invalid. Please log in again."
      });
    }

    const transactionCode = String(
      req.body && req.body.transaction_code || ""
    ).trim().toUpperCase();

    const phone = normalizePhone(req.body && req.body.phone);
    const proofPath = String(req.body && req.body.proof_path || "").trim();

    if (!/^[A-Z0-9]{6,20}$/.test(transactionCode)) {
      return res.status(400).json({
        error: "Enter a valid M-Pesa transaction code."
      });
    }

    // Only allow a screenshot inside this member's own folder.
    const expectedPrefix = user.id + "/";
    const validFileName =
      /^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i;

    const fileName = proofPath.startsWith(expectedPrefix)
      ? proofPath.slice(expectedPrefix.length)
      : "";

    if (
      !fileName ||
      fileName.includes("/") ||
      !validFileName.test(fileName)
    ) {
      return res.status(400).json({
        error: "Invalid payment screenshot path."
      });
    }

    // Confirm that the screenshot exists in the private bucket.
    const encodedPath = proofPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const proofResponse = await fetch(
      supabaseUrl + "/storage/v1/object/payment-proofs/" + encodedPath,
      {
        method: "HEAD",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey
        }
      }
    );

    if (!proofResponse.ok) {
      return res.status(400).json({
        error: "The payment screenshot was not found. Please upload it again."
      });
    }

    // Prevent reuse of an M-Pesa transaction code.
    const duplicateResponse = await fetch(
      supabaseUrl +
      "/rest/v1/payments?transaction_code=eq." +
      encodeURIComponent(transactionCode) +
      "&select=id&limit=1",
      {
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey
        }
      }
    );

    const duplicates = await readResponse(duplicateResponse);

    if (!duplicateResponse.ok) {
      throw new Error("Could not check the transaction code.");
    }

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      return res.status(409).json({
        error: "This M-Pesa transaction code has already been submitted."
      });
    }

    // Avoid multiple pending submissions from the same member.
    const pendingResponse = await fetch(
      supabaseUrl +
      "/rest/v1/payments?user_id=eq." +
      encodeURIComponent(user.id) +
      "&status=eq.pending&select=id&limit=1",
      {
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey
        }
      }
    );

    const pendingPayments = await readResponse(pendingResponse);

    if (!pendingResponse.ok) {
      throw new Error("Could not check your existing payment submissions.");
    }

    if (Array.isArray(pendingPayments) && pendingPayments.length > 0) {
      return res.status(409).json({
        error: "You already have a payment awaiting review. Please wait for the administrator."
      });
    }

    // Create a pending payment. Only an administrator can approve it.
    const insertResponse = await fetch(
      supabaseUrl + "/rest/v1/payments",
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify([{
          user_id: user.id,
          amount: 50,
          phone: phone,
          transaction_code: transactionCode,
          proof_path: proofPath,
          payment_method: "pochi",
          status: "pending"
        }])
      }
    );

    const inserted = await readResponse(insertResponse);

    if (!insertResponse.ok) {
      console.error("Payment insert failed:", inserted);
      throw new Error("Could not save your payment submission.");
    }

    return res.status(201).json({
      success: true,
      message: "Payment details submitted. Your payment is awaiting administrator verification.",
      payment: Array.isArray(inserted) ? inserted[0] : null
    });

  } catch (error) {
    console.error("Manual payment submission error:", error);

    return res.status(500).json({
      error: error.message || "Payment submission failed."
    });
  }
};