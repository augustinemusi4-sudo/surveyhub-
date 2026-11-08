module.exports = async function handler(req, res) {
  return res.status(410).json({
    success: false,
    error: "STK Push is disabled. Please use the manual M-Pesa payment option on SurveyHub Kenya."
  });
};