// EmailJS notification helper. Fires-and-forgets: a failed email should
// never block an order submission.
(function () {
  const cfg = window.__WCE_CONFIG__ || {};
  let ready = false;

  function init() {
    if (!window.emailjs || !cfg.EMAILJS_PUBLIC_KEY) return;
    try {
      window.emailjs.init({ publicKey: cfg.EMAILJS_PUBLIC_KEY });
      ready = true;
    } catch (err) {
      console.error("[email] init failed", err);
    }
  }

  async function sendOrderNotification({ location, urgent, message }) {
    init();
    if (!ready) {
      console.warn("[email] EmailJS not configured, skipping notification");
      return;
    }
    const subject = urgent
      ? `Urgent: [URGENT] Inventory Request — WCE ${location}`
      : `Inventory Request — WCE ${location}`;

    // The EmailJS template (wce_order) only exposes {{subject}} and
    // {{message}}. The recipient list (windycityeatz7@gmail.com,
    // pcashay@gmail.com) is configured as the fixed "To Email" field on
    // the template itself in the EmailJS dashboard -- see README.
    try {
      await window.emailjs.send(cfg.EMAILJS_SERVICE_ID, cfg.EMAILJS_TEMPLATE_ID, {
        subject,
        message,
      });
    } catch (err) {
      console.error("[email] send failed", err);
    }
  }

  window.WCE = window.WCE || {};
  window.WCE.email = { sendOrderNotification };
})();
