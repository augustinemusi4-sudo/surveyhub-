function getEnv(name) {
  if (!process.env[name]) {
    throw new Error("Missing environment variable: " + name);
  }
  return process.env[name];
}

async function apiRequest(path, options = {}) {
  const url = getEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(url + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Supabase API error:", data);
    throw new Error("A database operation failed.");
  }

  return data;
}

async function verifyAdmin(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);
  const url = getEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(url + "/auth/v1/user", {
    headers: {
      apikey: key,
      Authorization: "Bearer " + token
    }
  });

  if (!response.ok) return null;

  const user = await response.json();

  if (!user.id) return null;

  const profiles = await apiRequest(
    "/rest/v1/profiles?id=eq." +
    encodeURIComponent(user.id) +
    "&select=id,is_admin&limit=1"
  );

  if (
    !Array.isArray(profiles) ||
    !profiles.length ||
    profiles[0].is_admin !== true
  ) {
    return null;
  }

  return user;
}

function encodeStoragePath(path) {
  return String(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

async function createScreenshotLink(path) {
  const encodedPath = encodeStoragePath(path);

  const result = await apiRequest(
    "/storage/v1/object/sign/payment-proofs/" + encodedPath,
    {
      method: "POST",
      body: JSON.stringify({
        expiresIn: 3600
      })
    }
  );

  const signedPath = result.signedURL || result.signedUrl;

  if (!signedPath) return null;

  if (signedPath.startsWith("http://") ||
      signedPath.startsWith("https://")) {
    return signedPath;
  }

  return getEnv("SUPABASE_URL").replace(/\/$/, "") +
    "/storage/v1" + signedPath;
}

module.exports = async function handler(req, res) {
  if (!["GET", "PATCH"].includes(req.method)) {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const admin = await verifyAdmin(req);

    if (!admin) {
      return res.status(403).json({
        error: "Administrator access required."
      });
    }

    // ADMIN: List pending payments.
    if (req.method === "GET") {
      const payments = await apiRequest(
        "/rest/v1/payments?status=eq.pending" +
        "&select=id,user_id,amount,phone,transaction_code,proof_path,payment_method,status,created_at" +
        "&order=created_at.desc"
      );

      const results = await Promise.all(
        (payments || []).map(async payment => {
          let proofUrl = null;

          if (payment.proof_path) {
            try {
              proofUrl = await createScreenshotLink(
                payment.proof_path
              );
            } catch (error) {
              console.error(
                "Could not create screenshot link:",
                payment.id
              );
            }
          }

          return {
            ...payment,
            proof_url: proofUrl
          };
        })
      );

      return res.status(200).json({
        success: true,
        payments: results
      });
    }

    // ADMIN: Approve or reject a pending payment.
    const paymentId = String(
      req.body && req.body.payment_id || ""
    ).trim();

    const action = String(
      req.body && req.body.action || ""
    ).trim().toLowerCase();

    const validUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!validUuid.test(paymentId)) {
      return res.status(400).json({
        error: "A valid payment ID is required."
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        error: "Action must be approve or reject."
      });
    }

    const newStatus =
      action === "approve" ? "confirmed" : "rejected";

    const updated = await apiRequest(
      "/rest/v1/payments?id=eq." +
      encodeURIComponent(paymentId) +
      "&status=eq.pending",
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: newStatus,
          reviewed_at: new Date().toISOString(),
          reviewed_by: admin.id
        })
      }
    );

    if (!Array.isArray(updated) || updated.length === 0) {
      return res.status(409).json({
        error: "Payment not found or it has already been reviewed."
      });
    }

    return res.status(200).json({
      success: true,
      message: action === "approve"
        ? "Payment approved successfully."
        : "Payment rejected successfully.",
      payment: updated[0]
    });

  } catch (error) {
    console.error("Admin payment error:", error);

    return res.status(500).json({
      error: "Administrator payment operation failed."
    });
  }
};