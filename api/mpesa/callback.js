module.exports = async function handler(req, res) {
  return res.status(410).json({
    success: false,
    error: "Automatic M-Pesa callbacks are disabled. Payments are verified manually by an administrator."
  });
};