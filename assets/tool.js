/* PDF Bridge: one free conversion in the browser, on a computer.
 *
 * Every tool page has <section class="try" data-tool="..."> and loads this file. On a computer it shows a
 * drop zone and converts one file free (the server remembers the computer, so a second try is refused).
 * On a phone or tablet it says the apps are coming soon and offers to send an email when they are out.
 * Every page also asks for a rating and a few words, so the tools can get better.
 */
(function () {
  "use strict";

  // On a development Mac (the site served at localhost) the local server; otherwise the real one.
  var API = location.hostname === "localhost" ? "http://localhost:8877/v1/web" : "https://api.pdfbridge.app/v1/web";
  // Cloudflare Turnstile site key (a free robot check). Empty: none; the server's other limits still apply.
  var TURNSTILE_SITEKEY = "";
  var MAX_MB = 10;

  var TOOLS = {
    "pdf-to-word": { accept: ".pdf,application/pdf", files: 1, verb: "Convert to Word", what: "a PDF", out: "Word document" },
    "pdf-to-excel": { accept: ".pdf,application/pdf", files: 1, verb: "Convert to Excel", what: "a PDF", out: "Excel spreadsheet", password: true },
    "bank-statement": { tool: "pdf-to-excel", accept: ".pdf,application/pdf", files: 1, verb: "Convert to Excel", what: "a bank statement PDF", out: "Excel spreadsheet", password: true },
    "compress-pdf": { accept: ".pdf,application/pdf", files: 1, verb: "Compress PDF", what: "a PDF", out: "smaller PDF", level: true,
      note: "Need an exact limit like 100 KB or 200 KB? That's in the PDF Bridge app, coming soon." },
    "image-to-word": { accept: "image/*,.heic", files: 5, verb: "Get the text", what: "photos or screenshots of text (up to 5)", out: "Word document with the text" },
    "images-to-pdf": { accept: "image/*,.heic", files: 5, verb: "Make a PDF", what: "photos of pages (up to 5)", out: "PDF" },
    "id-copy": { accept: "image/*,.heic", files: 2, verb: "Make the copy", what: "two photos: the front and the back", out: "printable PDF", sides: true },
    "fill-pdf": { tool: "form-fields", accept: ".pdf,application/pdf", files: 1, verb: "Find the fields", what: "a PDF form", out: "filled PDF", form: true }
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
      }); });
  }

  function track(name, props) {
    try { if (window.gtag) window.gtag("event", name, props || {}); } catch (e) { /* no analytics */ }
  }

  // --- the parts of the box -----------------------------------------------------------------------

  function waitlist(tool, intro) {
    var status = el("p", { class: "try-note", role: "status" });
    var email = el("input", { type: "email", required: true, placeholder: "you@example.com", "aria-label": "Your email", autocomplete: "email" });
    var phone = el("select", { "aria-label": "Your phone" }, [
      el("option", { value: "android", text: "Android" }), el("option", { value: "iphone", text: "iPhone" })]);
    if (phoneKind() === "iphone") phone.value = "iphone";
    var button = el("button", { class: "btn btn-primary", type: "submit", text: "Notify me" });
    var form = el("form", { class: "try-row", onsubmit: function (e) {
      e.preventDefault();
      button.disabled = true;
      postJSON("/waitlist", { email: email.value, platform: phone.value, tool: tool }).then(function () {
        form.replaceWith(el("p", { class: "try-good", text: "Thanks! We'll email you once when the app is out. Nothing else." }));
        track("waitlist_join", { tool: tool, platform: phone.value });
      }).catch(function (err) { status.textContent = err.message; button.disabled = false; });
    } }, [email, phone, button]);
    var first = !document.getElementById("notify");
    return el("div", { class: "try-wait", id: first ? "notify" : null }, [
      el("h3", { text: "The PDF Bridge apps are coming soon" }),
      el("p", { text: intro || "Get an email the day the Android or iPhone app is out. One email, no spam." }),
      form, status]);
  }

  function feedback(tool, title) {
    var rating = 0;
    var stars = [1, 2, 3, 4, 5].map(function (n) {
      return el("button", { type: "button", class: "star", "aria-label": n + " star" + (n > 1 ? "s" : ""), "aria-pressed": "false", text: "★",
        onclick: function () {
          rating = n;
          stars.forEach(function (s, i) { s.classList.toggle("on", i < n); s.setAttribute("aria-pressed", i < n ? "true" : "false"); });
        } });
    });
    var text = el("textarea", { rows: 3, maxlength: 2000, placeholder: "What worked, what didn't, which tool you'd like next…", "aria-label": "Your feedback" });
    var email = el("input", { type: "email", placeholder: "Email, if you'd like a reply (optional)", "aria-label": "Email for a reply", autocomplete: "email" });
    var status = el("p", { class: "try-note", role: "status" });
    var button = el("button", { class: "btn btn-ghost", type: "submit", text: "Send feedback" });
    var form = el("form", { class: "try-feedback", onsubmit: function (e) {
      e.preventDefault();
      if (!rating && !text.value.trim()) { status.textContent = "Pick a rating or write a few words."; return; }
      button.disabled = true;
      postJSON("/feedback", { tool: tool, rating: rating || null, text: text.value, email: email.value.trim() || null }).then(function () {
        form.replaceWith(el("p", { class: "try-good", text: "Thank you. Every message is read." }));
        track("feedback_sent", { tool: tool, rating: rating });
      }).catch(function (err) { status.textContent = err.message; button.disabled = false; });
    } }, [
      el("h3", { text: title || "How was it?" }),
      el("div", { class: "stars", role: "group", "aria-label": "Rating" }, stars),
      text, email, el("div", { class: "try-row" }, [button]), status]);
    return form;
  }

  function download(job, secret) {
    var files = (job.result && job.result.files) || (job.result && job.result.filename ? [{ filename: job.result.filename }] : []);
    return el("div", { class: "try-done" }, files.map(function (file, i) {
      return el("a", { class: "btn btn-primary", href: API + "/jobs/" + job.id + "/result?s=" + encodeURIComponent(secret) + "&part=" + i,
        download: file.filename || "", text: "Download " + (file.filename || "your file") });
    }));
  }

  // --- the box ------------------------------------------------------------------------------------

  function mount(box) {
    var key = box.getAttribute("data-tool");
    var spec = TOOLS[key];
    if (key === "notify") return notifyOnly(box);
    if (!spec) return;
    var tool = spec.tool || key;
    var page = location.pathname.replace(/\//g, "") || "home";
    box.innerHTML = "";
    var inner = el("div", { class: "try-card" });
    box.appendChild(inner);

    if (isPhone()) {
      inner.appendChild(el("p", { class: "kicker", text: "Free try on a computer" }));
      inner.appendChild(el("p", { class: "try-lead", text: "The free in-browser conversion works on a computer. On your phone, the PDF Bridge app is the way, and it's coming soon." }));
      inner.appendChild(waitlist(page));
      inner.appendChild(feedback(page, "Tell us what you need"));
      return;
    }

    var head = el("div", {}, [
      el("p", { class: "kicker", text: "Try it free, right here" }),
      el("h2", { text: "Convert one file free in your browser" }),
      el("p", { class: "try-lead", text: "Choose " + spec.what + " and get " + (/^[aeiou]/i.test(spec.out) ? "an " : "a ") + spec.out + ". No account. Your file is deleted within the hour. One free conversion per computer; the phone apps (coming soon) do more." })]);
    if (spec.note) head.appendChild(el("p", { class: "try-note", text: spec.note }));
    inner.appendChild(head);

    var stage = el("div", { class: "try-stage" });
    inner.appendChild(stage);
    var side = el("div", { class: "try-side" }, [waitlist(page, "Want PDF Bridge on your phone? Get one email when the app is out."), feedback(page)]);
    inner.appendChild(side);

    visitor().then(function (who) {
      return postJSON("/check", { visitor: who });
    }).then(function (state) {
      if (state.free) picker(); else used(state.message, state.reason);
    }).catch(function () { picker(); });

    function used(message, reason) {
      stage.innerHTML = "";
      var busy = reason === "busy" || reason === "today";
      stage.appendChild(el("div", { class: "try-used" }, [
        el("h3", { text: busy ? "Free conversions are busy right now" : "Your free conversion is used" }),
        el("p", { text: message || "This computer has already used its free conversion." }),
        el("p", { text: "The PDF Bridge apps for Android and iPhone are coming soon, with weekly free conversions. Leave your email beside this and we'll tell you the day they're out." })]));
    }

    function picker() {
      stage.innerHTML = "";
      var chosen = [];
      var list = el("ul", { class: "try-files" });
      var input = el("input", { type: "file", accept: spec.accept, multiple: spec.files > 1, class: "try-input", id: "try-file-" + key, "aria-label": "Choose " + spec.what });
      var zone = el("label", { class: "try-zone", for: "try-file-" + key }, [
        el("b", { text: "Drop " + spec.what + " here" }), el("span", { text: "or click to choose · up to " + MAX_MB + " MB each" })]);
      var options = el("div", { class: "try-options" });
      var password = null;
      var level = null;
      if (spec.password) {
        password = el("input", { type: "password", placeholder: "Password, if the PDF is locked (optional)", autocomplete: "off", "aria-label": "PDF password" });
        options.appendChild(password);
      }
      if (spec.level) {
        level = el("select", { "aria-label": "How much to compress" }, [
          el("option", { value: "balanced", text: "Smaller file, good quality" }), el("option", { value: "light", text: "Best quality, a bit smaller" })]);
        options.appendChild(level);
      }
      var error = el("p", { class: "try-error", role: "alert" });
      var go = el("button", { class: "btn btn-primary", type: "button", text: spec.verb + " free", disabled: true });

      function show() {
        list.innerHTML = "";
        chosen.forEach(function (file, i) {
          var label = spec.sides ? (i === 0 ? "Front: " : "Back: ") : "";
          list.appendChild(el("li", {}, [label + file.name + " (" + (file.size / 1048576).toFixed(1) + " MB)",
            el("button", { type: "button", class: "try-x", "aria-label": "Remove " + file.name, text: "×",
              onclick: function () { chosen.splice(i, 1); show(); } })]));
        });
        var need = spec.sides ? 2 : 1;
        go.disabled = chosen.length < need;
        error.textContent = spec.sides && chosen.length === 1 ? "Now add the photo of the back." : "";
      }

      function add(files) {
        error.textContent = "";
        Array.prototype.forEach.call(files, function (file) {
          if (file.size > MAX_MB * 1048576) { error.textContent = file.name + " is over " + MAX_MB + " MB."; return; }
          if (chosen.length < spec.files) chosen.push(file);
        });
        show();
      }

      input.addEventListener("change", function () { add(input.files); input.value = ""; });
      zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
      zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("over"); add(e.dataTransfer.files); });
      go.addEventListener("click", function () {
        var extra = {};
        if (password && password.value) extra.password = password.value;
        if (level) extra.level = level.value;
        if (spec.form) fields(chosen[0], extra); else send(tool, chosen, extra);
      });
      stage.append(zone, input, list, options, el("div", { class: "try-row" }, [go]), error);
    }

    function working(text) {
      stage.innerHTML = "";
      var bar = el("div", { class: "try-bar" }, [el("i")]);
      var note = el("p", { class: "try-note", role: "status", text: text });
      stage.append(note, bar);
      return { bar: bar.firstChild, note: note };
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
      });
    }

    function wait(job, secret, view) {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          fetch(API + "/jobs/" + job.id + "?s=" + encodeURIComponent(secret)).then(function (res) { return res.json(); }).then(function (now) {
            if (view && now.progress != null) view.bar.style.width = Math.max(8, now.progress) + "%";
            if (now.status === "done") return resolve(now);
            if (now.status === "failed") return reject(problem({ detail: now.error }, "That file couldn't be converted."));
            if (++tries > 400) return reject({ message: "This is taking too long. Please try again." });
            setTimeout(poll, tries < 10 ? 1000 : 2000);
          }).catch(function () { if (++tries > 400) reject({ message: "Lost the connection." }); else setTimeout(poll, 2500); });
        })();
      });
    }

    function failed(err) {
      if (err.code === "trial_used") return used(err.message, err.reason);
      stage.innerHTML = "";
      stage.appendChild(el("div", { class: "try-used" }, [
        el("h3", { text: "That didn't work" }), el("p", { text: err.message }),
        el("p", { text: "Your free conversion is still yours." }),
        el("button", { class: "btn btn-primary", type: "button", text: "Try another file", onclick: picker })]));
      track("web_convert_fail", { tool: tool, code: err.code || "" });
    }

    function send(name, files, extra) {
      var view = working("Uploading…");
      track("web_convert_start", { tool: name });
      upload(name, files, extra).then(function (job) {
        view.note.textContent = "Converting… this usually takes under a minute.";
        return wait(job, job.secret, view).then(function (done) {
          stage.innerHTML = "";
          stage.append(el("h3", { class: "try-good", text: "Ready." }), download(done, job.secret),
            el("p", { class: "try-note", text: "Download it now: the file is deleted from our server within the hour." }));
          track("web_convert_done", { tool: name });
        });
      }).catch(failed);
    }

    // Fill a form: find the fields first (free, doesn't use the try), then fill them in here.
    function fields(file, extra) {
      var view = working("Finding the fields in your form…");
      upload("form-fields", [file], extra).then(function (job) {
        return wait(job, job.secret, view).then(function (done) {
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
      var go = el("button", { class: "btn btn-primary", type: "button", text: "Fill the PDF free" });
      go.addEventListener("click", function () {
        var answers = inputs.map(function (x) {
          var value = x.control.type === "checkbox" ? x.control.checked : x.control.value;
          if (value === "" || value === false && x.field.value !== true) return null;
          var f = x.field;
          return f.source === "field" ? { id: f.id, value: value }
            : { page: f.page, box: f.box, type: f.type === "multiline" ? "multiline" : f.type === "check" ? "check" : f.type === "comb" ? "comb" : "text", value: value, cells: f.cells };
        }).filter(Boolean);
        if (!answers.length) { error.textContent = "Fill in at least one field."; return; }
        send("form-fill", [file], { answers: JSON.stringify(answers) });
      });
      var error = el("p", { class: "try-error", role: "alert" });
      stage.append(el("h3", { text: "Fill in your form" }), grid,
        signs ? el("p", { class: "try-note", text: "Signing is in the PDF Bridge app (coming soon). Everything else can be filled here." }) : null,
        el("div", { class: "try-row" }, [go]), error);
    }
  }

  // The home page: no converter (each tool page has its own), just the app waitlist and feedback.
  function notifyOnly(box) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "try-card" }, [
      el("div", {}, [
        el("p", { class: "kicker", text: "Coming soon" }),
        el("h2", { text: "PDF Bridge for Android and iPhone" }),
        el("p", { class: "try-lead", text: isPhone()
          ? "The apps are almost ready. Leave your email and we'll tell you the day they're out. On a computer, every tool page lets you convert one file free in your browser."
          : "The apps are almost ready. Meanwhile, open any tool below and convert one file free, right in your browser." })]),
      waitlist("home"), feedback("home", "Tell us what you need")]));
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

  // Store buttons for apps that aren't out yet: they open the "tell me when it's out" box.
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
    if (isPhone()) {
      // The free try is for computers: on a phone, the buttons that lead to it say what's there instead.
      document.querySelectorAll(".try-cta").forEach(function (b) { b.remove(); });
      document.querySelectorAll('.site-head a.btn[href="#try"], .site-head a.btn[href="/#tools"]').forEach(function (b) {
        b.textContent = "Get notified";
        b.setAttribute("href", "#notify");
        b.setAttribute("data-notify", "");
      });
    }
    document.querySelectorAll("section.try[data-tool]").forEach(mount);
    comingSoon();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
