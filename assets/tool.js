/* PDF Bridge: one free conversion in the browser, on a computer.
 *
 * Every tool page has <section class="try" data-tool="..."> in its hero and loads this file. On a computer
 * it shows a drop zone and converts one file free (the server remembers the computer, so a second try is
 * refused). On a phone or tablet it says the apps are coming soon and offers one email when they are out.
 * <section data-extras="page"> near the end of a page gets the app waitlist and a feedback form.
 * After a conversion, the result asks how it came out.
 */
(function () {
  "use strict";

  // On a development Mac (the site served at localhost) the local server; otherwise the real one.
  var API = location.hostname === "localhost" ? "http://localhost:8877/v1/web" : "https://api.pdfbridge.app/v1/web";
  // Cloudflare Turnstile site key (a free robot check). Empty: none; the server's other limits still apply.
  var TURNSTILE_SITEKEY = "";
  var MAX_MB = 10;

  var PDF = "PDF";
  var PHOTO = "JPG, PNG or HEIC";
  var TOOLS = {
    "pdf-to-word": { accept: ".pdf,application/pdf", files: 1, verb: "Convert to Word", what: "a PDF", kind: PDF, out: "Word document" },
    "pdf-to-excel": { accept: ".pdf,application/pdf", files: 1, verb: "Convert to Excel", what: "a PDF", kind: PDF, out: "Excel spreadsheet", password: true },
    "bank-statement": { tool: "pdf-to-excel", accept: ".pdf,application/pdf", files: 1, verb: "Convert to Excel", what: "a bank statement PDF", kind: PDF, out: "Excel spreadsheet", password: true },
    "compress-pdf": { accept: ".pdf,application/pdf", files: 1, verb: "Compress PDF", what: "a PDF", kind: PDF, out: "smaller PDF", level: true,
      note: "Need an exact limit like 100 KB or 200 KB? That's in the PDF Bridge app, coming soon." },
    "image-to-word": { accept: "image/*,.heic", files: 5, verb: "Get the text", what: "photos of text", kind: PHOTO, out: "Word document", more: "Add another photo" },
    "images-to-pdf": { accept: "image/*,.heic", files: 5, verb: "Make the PDF", what: "photos of pages", kind: PHOTO, out: "PDF", more: "Add another page" },
    "id-copy": { accept: "image/*,.heic", files: 2, verb: "Make the copy", what: "photos of the front and back", kind: PHOTO, out: "printable PDF", sides: true, more: "Add the photo of the back" },
    "fill-pdf": { tool: "form-fields", accept: ".pdf,application/pdf", files: 1, verb: "Find the fields", what: "a PDF form", kind: PDF, out: "filled PDF", form: true }
  };

  // Line icons (static markup, never built from input).
  var ICON = {
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 14.5l3-3 3 3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"/></svg>'
  };

  // --- small helpers ------------------------------------------------------------------------------

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "html") node.innerHTML = attrs[key];
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== false && attrs[key] != null) node.setAttribute(key, attrs[key] === true ? "" : attrs[key]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid); });
    return node;
  }

  function icon(name) { return el("span", { html: ICON[name], style: "display:contents" }); }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* private windows may refuse: the cookie below still works */ }
    return value;
  }

  function cookie(name, value) {
    if (value === undefined) {
      var found = document.cookie.match(new RegExp("(?:^|; )" + name + "=([0-9a-f]{32})"));
      return found ? found[1] : null;
    }
    document.cookie = name + "=" + value + "; max-age=31536000; path=/; SameSite=Lax; Secure";
    return value;
  }

  function randomHex() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function sha(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("").slice(0, 32);
    });
  }

  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  }

  // A phone or tablet: the free try is for computers (iPads say "Macintosh" but have a touch screen).
  function isPhone() {
    var ua = navigator.userAgent || "";
    if (/Mobi|Android|iPhone|iPad|iPod|Windows Phone|Opera Mini|IEMobile/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return window.matchMedia && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  }

  function phoneKind() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iphone";
    return /Android/i.test(ua) ? "android" : "unknown";
  }

  // --- recognising this computer (see app/web.py on the server) ----------------------------------

  function gpu() {
    try {
      var gl = document.createElement("canvas").getContext("webgl");
      var info = gl && gl.getExtension("WEBGL_debug_renderer_info");
      var raw = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "";
      return String(raw || "");
    } catch (e) { return ""; }
  }

  // The graphics chip's model, written the same way whichever browser reports it.
  function gpuModel(raw) {
    var text = raw.toLowerCase().replace(/^angle \((.*)\)$/, "$1");
    var parts = text.split(",").map(function (p) { return p.trim(); });
    var best = parts.filter(function (p) { return /\d|apple m|iris|radeon|geforce|arc/.test(p); })[0] || parts[0] || "";
    best = best.replace(/angle metal renderer:|metal renderer:|opengl engine|direct3d\d+|vs_\d_\d|ps_\d_\d|d3d\d+|\(0x[0-9a-f]+\)|\((r|tm)\)|or similar|unspecified version/g, " ")
      .replace(/\s+/g, " ").trim();
    // Too vague to tell computers apart (Safari hides the model; software drawing has none).
    if (!best || /^(apple gpu|swiftshader|llvmpipe|software|mesa|webkit webgl|generic renderer)/.test(best)) return "";
    return best;
  }

  function canvasPrint() {
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 60;
      var ctx = canvas.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "16px Arial";
      ctx.fillStyle = "#f60"; ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = "#069"; ctx.fillText("PDF Bridge, \u{1F4C4} 1.0", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)"; ctx.fillText("PDF Bridge, \u{1F4C4} 1.0", 4, 17);
      return canvas.toDataURL();
    } catch (e) { return ""; }
  }

  var visitorPromise = null;
  function visitor() {
    if (visitorPromise) return visitorPromise;
    var token = store("pb_v") || cookie("pb_v");
    if (!token || !/^[0-9a-f]{32}$/.test(token)) token = randomHex();
    store("pb_v", token);
    cookie("pb_v", token);
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* old browser */ }
    var sizes = [screen.width, screen.height].sort(function (a, b) { return a - b; }).join("x");
    var model = gpuModel(gpu());
    var system = (navigator.platform || "").toLowerCase().replace(/\s.*/, "");
    var browser = [canvasPrint(), navigator.userAgent, (navigator.languages || []).join(","), sizes, screen.colorDepth,
      tz, navigator.hardwareConcurrency, gpu()].join("|");
    var computer = model ? [model, sizes, screen.colorDepth, navigator.hardwareConcurrency, tz, system].join("|") : "";
    visitorPromise = Promise.all([sha(browser), computer ? sha(computer) : Promise.resolve("")]).then(function (prints) {
      return { t: token, b: prints[0], h: prints[1] };
    });
    return visitorPromise;
  }

  // --- talking to the server ----------------------------------------------------------------------

  function problem(body, fallback) {
    var detail = body && body.detail;
    if (detail && typeof detail === "object" && detail.message) return detail;
    if (typeof detail === "string") return { message: detail };
    return { message: fallback || "Something went wrong. Please try again." };
  }

  function postJSON(path, payload) {
    return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw problem(body);
        return body;
      }); }, function () { throw { message: "We couldn't reach PDF Bridge. Check your connection and try again." }; });
  }

  function track(name, props) {
    try { if (window.gtag) window.gtag("event", name, props || {}); } catch (e) { /* no analytics */ }
  }

  var uid = 0;
  function field(label, control, hint) {
    var id = "pb-f" + (++uid);
    control.id = id;
    return el("div", { class: "try-label" }, [
      el("label", { for: id }, [label, hint ? el("span", { class: "hint", text: " " + hint }) : null]), control]);
  }

  // Busy while sending: the button stays readable and says what's happening.
  function busy(button, on, label) {
    if (on) { button.dataset.label = button.textContent; button.textContent = label; button.setAttribute("aria-busy", "true"); button.disabled = true; }
    else { button.textContent = button.dataset.label || button.textContent; button.removeAttribute("aria-busy"); button.disabled = false; }
  }

  // --- the app waitlist and feedback ---------------------------------------------------------------

  function waitlist(tool) {
    var status = el("p", { class: "try-error", role: "alert" });
    var email = el("input", { type: "email", name: "email", autocomplete: "email", placeholder: "name@example.com", "aria-describedby": "" });
    var phone = el("select", { name: "platform" }, [
      el("option", { value: "android", text: "Android" }), el("option", { value: "iphone", text: "iPhone" })]);
    if (phoneKind() === "iphone") phone.value = "iphone";
    var button = el("button", { class: "btn btn-primary", type: "submit", text: "Notify me" });
    function bad() { return !email.value.trim() || !email.checkValidity(); }
    function clear() { email.removeAttribute("aria-invalid"); status.textContent = ""; }
    email.addEventListener("blur", function () { if (email.value.trim() && bad()) { email.setAttribute("aria-invalid", "true"); status.textContent = "Enter an email address like name@example.com."; } });
    email.addEventListener("input", clear);
    var form = el("form", { class: "try-wait", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      if (bad()) { email.setAttribute("aria-invalid", "true"); status.textContent = "Enter an email address like name@example.com."; email.focus(); return; }
      busy(button, true, "Sending…");
      postJSON("/waitlist", { email: email.value.trim(), platform: phone.value, tool: tool }).then(function () {
        form.replaceWith(el("p", { class: "try-good", role: "status", text: "You're on the list. We'll send one email when the app is out, nothing else." }));
        track("waitlist_join", { tool: tool, platform: phone.value });
      }).catch(function (err) { status.textContent = err.message; busy(button, false); });
    } }, [
      el("div", { class: "try-row" }, [field("Email", email), field("Phone", phone), button]), status]);
    return form;
  }

  function feedback(tool, opts) {
    opts = opts || {};
    var rating = 0;
    var stars = [1, 2, 3, 4, 5].map(function (n) {
      return el("button", { type: "button", class: "star", html: ICON.star, "aria-label": n + " star" + (n > 1 ? "s" : ""), "aria-pressed": "false",
        onclick: function () {
          rating = n;
          status.textContent = "";
          stars.forEach(function (s, i) { s.classList.toggle("on", i < n); s.setAttribute("aria-pressed", i === n - 1 ? "true" : "false"); });
        } });
    });
    var text = el("textarea", { rows: 3, maxlength: 2000, placeholder: opts.placeholder || "A document that didn't convert well, or a tool you'd like next" });
    var email = el("input", { type: "email", autocomplete: "email", placeholder: "name@example.com" });
    var status = el("p", { class: "try-error", role: "alert" });
    var button = el("button", { class: "btn btn-ghost", type: "submit", text: "Send feedback" });
    text.addEventListener("input", function () { status.textContent = ""; });
    var form = el("form", { class: "try-feedback", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      if (!rating && !text.value.trim()) { status.textContent = "Pick a rating or write a few words, then send."; return; }
      if (email.value.trim() && !email.checkValidity()) { status.textContent = "Enter an email address like name@example.com, or leave it empty."; email.focus(); return; }
      busy(button, true, "Sending…");
      postJSON("/feedback", { tool: tool, rating: rating || null, text: text.value, email: email.value.trim() || null }).then(function () {
        form.replaceWith(el("p", { class: "try-good", role: "status", text: "Thank you. Every message is read." }));
        track("feedback_sent", { tool: tool, rating: rating });
      }).catch(function (err) { status.textContent = err.message; busy(button, false); });
    } }, [
      opts.title ? el("h3", { text: opts.title }) : null,
      el("fieldset", { class: "stars" }, [el("legend", { text: opts.ask || "Your rating" })].concat(stars)),
      field(opts.textLabel || "What should we improve?", text, "(optional)"),
      opts.short ? null : field("Email for a reply", email, "(optional)"),
      button, status]);
    return form;
  }

  // The bottom of a page: the app waitlist beside the feedback form.
  function extras(box) {
    var page = box.getAttribute("data-extras") || "home";
    box.innerHTML = "";
    var heroHasWaitlist = isPhone() && document.querySelector(".try[data-tool]");
    if (!heroHasWaitlist) {
      box.appendChild(el("div", { class: "panel" }, [
        el("h3", { text: "Get the app when it's out" }),
        el("p", { text: "PDF Bridge for Android and iPhone is almost ready. Leave your email and we'll send one message the day it's out." }),
        waitlist(page)]));
    }
    box.appendChild(el("div", { class: "panel" }, [
      el("h3", { text: "Tell us what you need" }),
      el("p", { text: "Rate a tool, tell us about a document that didn't come out right, or ask for the next tool. Every message is read." }),
      feedback(page)]));
    box.classList.toggle("one", box.children.length === 1);
  }

  function download(job, secret) {
    var files = (job.result && job.result.files) || (job.result && job.result.filename ? [{ filename: job.result.filename }] : []);
    return el("div", { class: "try-done" }, files.map(function (file, i) {
      return el("a", { class: "btn btn-primary", href: API + "/jobs/" + job.id + "/result?s=" + encodeURIComponent(secret) + "&part=" + i,
        download: file.filename || "" }, [icon("download"), el("span", { text: "Download " + (file.filename || "your file") })]);
    }));
  }

  // --- the converter ------------------------------------------------------------------------------

  function mount(box) {
    var key = box.getAttribute("data-tool");
    if (key === "notify") { box.setAttribute("data-extras", "home"); box.classList.add("extras"); return extras(box); }
    var spec = TOOLS[key];
    if (!spec) return;
    var tool = spec.tool || key;
    var page = location.pathname.replace(/\//g, "") || "home";
    box.innerHTML = "";
    var inner = el("div", { class: "try-card" });
    box.appendChild(inner);

    if (isPhone()) {
      var copy = el("button", { class: "btn btn-ghost", type: "button", text: "Copy this page's link",
        onclick: function () {
          var url = location.href.split("#")[0];
          var done = function () { copy.textContent = "Link copied"; };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { copy.textContent = url; });
          else copy.textContent = url;
        } });
      inner.append(
        el("div", { class: "try-head" }, [
          el("h2", { text: "Convert free on a computer" }),
          el("p", { text: "The free conversion runs in a browser on a computer. Open this page there, or get an email when the phone app is out." })]),
        el("div", { class: "try-stage" }, [copy, el("hr", { class: "try-sep" }),
          el("h3", { text: "Android and iPhone apps are coming soon" }), waitlist(page)]));
      return;
    }

    inner.appendChild(el("div", { class: "try-head" }, [
      el("h2", { text: "Convert a file free" }),
      el("p", { text: "Choose " + spec.what + " and get " + (/^[aeiou]/i.test(spec.out) ? "an " : "a ") + spec.out + ". One free file per computer, no account needed." })]));
    var stage = el("div", { class: "try-stage", "aria-live": "polite" });
    inner.appendChild(stage);
    stage.appendChild(el("div", { class: "try-zone", "aria-hidden": "true", style: "pointer-events:none" }, [
      icon("upload"), el("b", { text: "Checking your free conversion…" })]));

    visitor().then(function (who) {
      return postJSON("/check", { visitor: who });
    }).then(function (state) {
      if (state.free) picker(); else used(state.message, state.reason);
    }).catch(function () { picker(); });

    function safe() {
      return el("p", { class: "try-safe" }, [icon("lock"), el("span", { text: "Sent over an encrypted connection and deleted from our server within the hour." })]);
    }

    function used(message, reason) {
      stage.innerHTML = "";
      var busyNow = reason === "busy" || reason === "today";
      stage.append(
        el("div", { class: "try-used" }, [
          el("h3", { text: busyNow ? "Free conversions are busy right now" : "This computer has used its free conversion" }),
          el("p", { text: message || "This computer has already used its free conversion." }),
          el("p", { text: "The PDF Bridge apps for Android and iPhone are coming soon, with free conversions every week." })]),
        el("h3", { text: "Get an email when the app is out" }), waitlist(page));
    }

    function picker() {
      stage.innerHTML = "";
      var chosen = [];
      var need = spec.sides ? 2 : 1;
      var list = el("ul", { class: "try-files", "aria-label": "Chosen files" });
      var input = el("input", { type: "file", accept: spec.accept, multiple: spec.files > 1, class: "try-input", id: "try-file-" + key });
      var zoneText = el("b", { text: "Drop " + spec.what + " here" });
      var zone = el("label", { class: "try-zone", for: "try-file-" + key }, [
        icon("upload"), zoneText,
        el("span", { class: "or", html: "or <u>choose " + (spec.files > 1 ? "files" : "a file") + "</u>" }),
        el("small", { text: spec.kind + ", up to " + MAX_MB + " MB" + (spec.files > 1 ? " each" : "") })]);
      var options = el("div", { class: "try-options" });
      var password = null;
      var level = null;
      if (spec.password) {
        password = el("input", { type: "password", autocomplete: "off" });
        var passBox = field("PDF password", password, "(only if the PDF is locked)");
        var reveal = el("button", { type: "button", class: "btn-text", text: "Is the PDF locked? Add its password",
          onclick: function () { reveal.replaceWith(passBox); password.focus(); } });
        options.appendChild(reveal);
      }
      if (spec.level) {
        level = el("select", {}, [
          el("option", { value: "balanced", text: "Smaller file, good quality" }), el("option", { value: "light", text: "Best quality, a bit smaller" })]);
        options.appendChild(field("Compression", level));
      }
      var hint = el("p", { class: "try-note", role: "status" });
      var error = el("p", { class: "try-error", role: "alert" });
      var go = el("button", { class: "btn btn-primary try-go", type: "button", text: spec.verb + " free" });

      function show() {
        list.innerHTML = "";
        chosen.forEach(function (file, i) {
          var side = spec.sides ? (i === 0 ? "Front, " : "Back, ") : "";
          list.appendChild(el("li", {}, [icon("file"),
            el("span", { class: "name", title: file.name }, [file.name, el("small", { text: side + size(file.size) })]),
            el("button", { type: "button", class: "try-x", "aria-label": "Remove " + file.name, text: "Remove",
              onclick: function () { chosen.splice(i, 1); show(); input.focus(); } })]));
        });
        var full = chosen.length >= spec.files;
        zone.hidden = full;
        zone.classList.toggle("small", chosen.length > 0);
        zoneText.textContent = chosen.length ? (spec.more || "Choose another file") : "Drop " + spec.what + " here";
        options.hidden = !chosen.length;
        hint.textContent = spec.sides && chosen.length === 1 ? "Now add the photo of the back." : "";
        if (chosen.length >= need) error.textContent = "";
      }

      function add(files) {
        error.textContent = "";
        Array.prototype.forEach.call(files, function (file) {
          if (file.size > MAX_MB * 1048576) { error.textContent = file.name + " is " + size(file.size) + ". Choose a file up to " + MAX_MB + " MB."; return; }
          if (chosen.length < spec.files) chosen.push(file);
        });
        show();
      }

      input.addEventListener("change", function () { add(input.files); input.value = ""; });
      zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
      zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("over"); add(e.dataTransfer.files); });
      go.addEventListener("click", function () {
        if (chosen.length < need) {
          error.textContent = chosen.length ? "Add the photo of the back first." : "Choose " + spec.what + " first.";
          input.focus();
          return;
        }
        var extra = {};
        if (password && password.value) extra.password = password.value;
        if (level) extra.level = level.value;
        if (spec.form) fields(chosen[0], extra); else send(tool, chosen, extra);
      });
      stage.append(input, zone, list, hint, options, go, error);
      if (spec.note) stage.appendChild(el("p", { class: "try-note", text: spec.note }));
      stage.appendChild(safe());
      show();
    }

    function working(text, files) {
      stage.innerHTML = "";
      var bar = el("div", { class: "try-bar", role: "progressbar", "aria-label": "Progress", "aria-valuemin": "0", "aria-valuemax": "100" }, [el("i")]);
      var note = el("p", { class: "try-note", role: "status", text: text });
      stage.appendChild(el("div", { class: "try-progress" }, [
        el("span", { class: "name", text: files.map(function (f) { return f.name; }).join(", ") }), bar, note]));
      return { bar: bar.firstChild, holder: bar, note: note };
    }

    function upload(name, files, extra) {
      return visitor().then(function (who) {
        var data = new FormData();
        data.append("tool", name);
        data.append("visitor", JSON.stringify(who));
        Object.keys(extra).forEach(function (k) { data.append(k, extra[k]); });
        files.forEach(function (file) { data.append("files", file, file.name); });
        return robot().then(function (token) {
          if (token) data.append("captcha", token);
          return fetch(API + "/jobs", { method: "POST", body: data });
        });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) { var p = problem(body); p.status = res.status; throw p; }
          return body;
        });
      }, function (err) {
        if (err && err.message && !(err instanceof TypeError)) throw err;
        throw { message: "We couldn't reach PDF Bridge. Check your connection and try again." };
      });
    }

    function wait(job, secret, view) {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          fetch(API + "/jobs/" + job.id + "?s=" + encodeURIComponent(secret)).then(function (res) { return res.json(); }).then(function (now) {
            if (view && now.progress != null) {
              var pct = Math.max(8, now.progress);
              view.bar.style.width = pct + "%";
              view.holder.setAttribute("aria-valuenow", String(Math.round(pct)));
            }
            if (now.status === "done") return resolve(now);
            if (now.status === "failed") return reject(problem({ detail: now.error }, "That file couldn't be converted."));
            if (++tries > 400) return reject({ message: "This is taking too long. Please try again." });
            setTimeout(poll, tries < 10 ? 1000 : 2000);
          }).catch(function () { if (++tries > 400) reject({ message: "Lost the connection. Check your connection and try again." }); else setTimeout(poll, 2500); });
        })();
      });
    }

    function failed(err) {
      if (err.code === "trial_used") return used(err.message, err.reason);
      stage.innerHTML = "";
      stage.appendChild(el("div", { class: "try-used" }, [
        el("h3", { text: "This file didn't convert" }), el("p", { text: err.message }),
        el("p", { text: "Your free conversion is still yours." }),
        el("button", { class: "btn btn-primary", type: "button", text: "Try another file", onclick: picker })]));
      track("web_convert_fail", { tool: tool, code: err.code || "" });
    }

    function send(name, files, extra) {
      var view = working("Uploading…", files);
      track("web_convert_start", { tool: name });
      upload(name, files, extra).then(function (job) {
        view.note.textContent = "Converting. This usually takes under a minute.";
        return wait(job, job.secret, view).then(function (done) {
          stage.innerHTML = "";
          stage.appendChild(el("div", { class: "try-result" }, [
            el("div", { class: "ok" }, [icon("done"), el("h3", { text: "Your " + spec.out + " is ready" })]),
            download(done, job.secret),
            el("p", { class: "try-note", text: "Download it now: it's deleted from our server within the hour." }),
            el("hr", { class: "try-sep" }),
            feedback(page, { ask: "How did it come out?", textLabel: "Anything we should fix?", placeholder: "A table that moved, a number that's wrong…", short: true })]));
          track("web_convert_done", { tool: name });
        });
      }).catch(failed);
    }

    // Fill a form: find the fields first (free, doesn't use the try), then fill them in here.
    function fields(file, extra) {
      var view = working("Finding the fields in your form…", [file]);
      upload("form-fields", [file], extra).then(function (job) {
        return wait(job, job.secret, view).then(function () {
          return fetch(API + "/jobs/" + job.id + "/result?s=" + encodeURIComponent(job.secret)).then(function (r) { return r.json(); });
        });
      }).then(function (form) { fill(file, form); }).catch(failed);
    }

    function fill(file, form) {
      stage.innerHTML = "";
      var usable = (form.fields || []).filter(function (f) { return f.type !== "signature" && !f.readOnly; }).slice(0, 200);
      if (!usable.length) {
        stage.appendChild(el("div", { class: "try-used" }, [el("h3", { text: "No fields found" }),
          el("p", { text: "This PDF has no places to fill in that we could find. Your free conversion is still yours." }),
          el("button", { class: "btn btn-primary", type: "button", text: "Try another form", onclick: picker })]));
        return;
      }
      var inputs = [];
      var grid = el("div", { class: "try-form" });
      usable.forEach(function (f, i) {
        var label = (f.label || f.key || "Field " + (i + 1)).slice(0, 80);
        var control;
        if (f.type === "check") control = el("input", { type: "checkbox", checked: f.value === true });
        else if ((f.type === "choice" || f.type === "radio") && f.options && f.options.length) {
          control = el("select", {}, [el("option", { value: "", text: "—" })].concat(f.options.map(function (o) { return el("option", { value: o, text: o }); })));
          if (f.value) control.value = f.value;
        } else if (f.type === "multiline") control = el("textarea", { rows: 2, maxlength: 2000 });
        else control = el("input", { type: "text", maxlength: f.maxLength || 2000, value: typeof f.value === "string" ? f.value : "" });
        inputs.push({ field: f, control: control });
        grid.appendChild(el("label", { class: "try-field" }, [el("span", { text: label + " (page " + ((f.page || 0) + 1) + ")" }), control]));
      });
      var signs = (form.fields || []).some(function (f) { return f.type === "signature"; });
      var error = el("p", { class: "try-error", role: "alert" });
      var go = el("button", { class: "btn btn-primary try-go", type: "button", text: "Fill the PDF free" });
      go.addEventListener("click", function () {
        var answers = inputs.map(function (x) {
          var value = x.control.type === "checkbox" ? x.control.checked : x.control.value;
          if (value === "" || value === false && x.field.value !== true) return null;
          var f = x.field;
          return f.source === "field" ? { id: f.id, value: value }
            : { page: f.page, box: f.box, type: f.type === "multiline" ? "multiline" : f.type === "check" ? "check" : f.type === "comb" ? "comb" : "text", value: value, cells: f.cells };
        }).filter(Boolean);
        if (!answers.length) { error.textContent = "Fill in at least one field, then try again."; return; }
        send("form-fill", [file], { answers: JSON.stringify(answers) });
      });
      stage.append(el("h3", { text: usable.length + " field" + (usable.length > 1 ? "s" : "") + " found. Fill in your answers" }), grid);
      if (signs) stage.appendChild(el("p", { class: "try-note", text: "Signing is in the PDF Bridge app (coming soon). Everything else can be filled here." }));
      stage.append(go, error);
    }
  }

  // The robot check, only when a Turnstile key is set.
  var turnstileReady = null;
  function robot() {
    if (!TURNSTILE_SITEKEY) return Promise.resolve("");
    if (!turnstileReady) {
      turnstileReady = new Promise(function (resolve) {
        window.pbTurnstile = resolve;
        document.head.appendChild(el("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=pbTurnstile&render=explicit", async: true }));
      });
    }
    return turnstileReady.then(function () {
      return new Promise(function (resolve) {
        var holder = el("div", { class: "try-robot" });
        document.body.appendChild(holder);
        window.turnstile.render(holder, { sitekey: TURNSTILE_SITEKEY, callback: function (token) { resolve(token); holder.remove(); } });
      });
    });
  }

  // "Get notified" links: jump to the first waitlist email field on the page.
  function comingSoon() {
    document.querySelectorAll("[data-notify]").forEach(function (link) {
      link.addEventListener("click", function (e) {
        var target = document.querySelector(".try-wait input[type=email]");
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus({ preventScroll: true });
      });
    });
  }

  function start() {
    document.querySelectorAll(".try[data-tool]").forEach(mount);
    document.querySelectorAll("[data-extras]").forEach(extras);
    if (isPhone()) {
      // The free try is for computers: on a phone, the buttons that lead to it lead to the waitlist instead.
      var here = document.querySelector(".try-wait");
      document.querySelectorAll(".try-cta").forEach(function (b) { b.remove(); });
      document.querySelectorAll('.site-head a.btn[href="#try"], .site-head a.btn[href="/#start"]').forEach(function (b) {
        b.textContent = "Get notified";
        b.setAttribute("href", here ? "#notify" : "/#notify");
        if (here) b.setAttribute("data-notify", "");
      });
    }
    comingSoon();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
