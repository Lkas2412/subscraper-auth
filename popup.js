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
      (last.httpStatus ? " (HTTP " + last.httpStatus + ")" : "") + ".",
    "rechazado": "Último evento: el destino rechazó el envío" +
      (last.httpStatus ? " (HTTP " + last.httpStatus + ")" : "") + ".",
    "sin-sesion": "Último evento: entrada al sitio sin sesión completa " +
      "(falta auth_id o sess): logueate primero.",
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

document.getElementById("refresh").addEventListener("click", function () {
  ask("diagnose");
});
document.getElementById("force").addEventListener("click", function () {
  ask("force");
});
ask("diagnose");
