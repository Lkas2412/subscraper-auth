// Popup: pide el diagnostico al background y lo muestra. Solo
// presencias (si/no) y el ultimo evento registrado; ningun valor de
// sesion pasa por aca.
"use strict";

function setCell(id, ok, yesText, noText) {
  var el = document.getElementById(id);
  el.textContent = ok ? yesText : noText;
  el.className = ok ? "ok" : "bad";
}

function kindText(last) {
  if (!last) {
    return "Sin eventos todavía.";
  }
  var when = last.at ? new Date(last.at).toLocaleString() : "";
  var lines = {
    "posteado": "Último evento: auth enviado" +
      (last.httpStatus ? " (HTTP " + last.httpStatus + ")" : "") +
      (last.uaSource ? " · UA vía " + last.uaSource : "") + ".",
    "rechazado": "Último evento: el destino rechazó el envío" +
      (last.httpStatus ? " (HTTP " + last.httpStatus + ")" : "") + ".",
    "sin-sesion": "Último evento: entrada al sitio sin sesión completa " +
      "(falta auth_id o sess): logueate primero." +
      (last.shapes ? "\nVías de lectura: " + last.shapes + "." : ""),
    "sin-token": "Último evento: sesión presente pero el sitio aún no " +
      "generó el token bcTokenSha.",
    "ya-posteado-esta-sesion": "Último evento: esta sesión ya se posteó " +
      "en esta sesión del navegador.",
    "cookies-api-missing": "Último evento: este navegador NO expone la " +
      "API de cookies a la extensión (la cosecha no es posible acá).",
    "cookies-error": "Último evento: error leyendo cookies.",
    "error-red": "Último evento: error de red al postear.",
  };
  return (lines[last.kind] || ("Último evento: " + last.kind)) +
    (when ? "\n" + when : "");
}

function render(resp) {
  if (!resp) {
    document.getElementById("last").textContent =
      "El background no respondió (¿service worker dormido?). Reintentá.";
    return;
  }
  var d = resp.diag || {};
  setCell("d-cookies", !!d.cookiesApi, "disponible", "NO disponible");
  setCell("d-webhook", !!d.webhookConfigured, "sí", "no");
  if (typeof d.authId === "boolean") {
    setCell("d-authid", d.authId, "presente", "ausente");
  }
  if (typeof d.sess === "boolean") {
    setCell("d-sess", d.sess, "presente", "ausente");
  }
  setCell("d-token", !!d.token, "presente", "ausente");
  if (typeof d.uaForced === "boolean") {
    setCell("d-uarule", d.uaForced, "sí", "no");
  }
  document.getElementById("last").textContent = kindText(resp.last);
}

function ask(type) {
  chrome.runtime.sendMessage({ type: type }, function (resp) {
    // Leer lastError explicitamente: si el background no respondio,
    // resp llega undefined y render muestra el aviso; sin esta
    // lectura Chrome registra un error no chequeado en consola.
    var ignored = chrome.runtime.lastError;
    void ignored;
    render(resp);
  });
}

// User-Agent manual (override): en navegadores cuyo entorno de
// extensiones se identifica distinto de lo que el sitio ve (Orion),
// el usuario declara el UA verdadero una vez y la cosecha lo usa
// siempre. Vacio = vias automaticas.
function loadOverride() {
  try {
    chrome.storage.local.get("uaOverride", function (r) {
      var ignored = chrome.runtime.lastError;
      void ignored;
      if (r && typeof r.uaOverride === "string") {
        document.getElementById("ua-override").value = r.uaOverride;
      }
    });
  } catch (e) {
    // sin storage: el campo queda como decoracion inerte
  }
}
document.getElementById("ua-save").addEventListener("click", function () {
  var v = document.getElementById("ua-override").value.trim();
  var last = document.getElementById("last");
  try {
    chrome.runtime.sendMessage({ type: "set-ua", ua: v }, function (resp) {
      var err = chrome.runtime.lastError;
      if (err || !resp) {
        // Background viejo o dormido: se guarda la etiqueta igual,
        // sin forzado de red (comportamiento de la v1.0.5).
        try {
          chrome.storage.local.set({ uaOverride: v });
        } catch (e) {
          // sin storage: nada que guardar
        }
        last.textContent = v
          ? "User-Agent guardado como etiqueta (sin confirmación de forzado)."
          : "User-Agent manual borrado.";
        return;
      }
      if (!v) {
        last.textContent =
          "User-Agent manual borrado: vuelven las vías automáticas y no se fuerza ningún UA.";
      } else if (resp.applied) {
        last.textContent =
          "User-Agent guardado y FORZADO en los pedidos al sitio: la sesión nacerá con esta identidad. Logueate de nuevo para estrenarla.";
      } else if (resp.api) {
        last.textContent =
          "User-Agent guardado como etiqueta, pero este navegador rechazó la regla de forzado.";
      } else {
        last.textContent =
          "User-Agent guardado como etiqueta: este navegador no ofrece forzado de red (la identidad del sitio se sigue ajustando en el navegador).";
      }
    });
  } catch (e) {
    last.textContent = "Este navegador no dejó guardar el User-Agent manual.";
  }
});
loadOverride();

document.getElementById("refresh").addEventListener("click", function () {
  ask("diagnose");
});
document.getElementById("force").addEventListener("click", function () {
  ask("force");
});
ask("diagnose");
