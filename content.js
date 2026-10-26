// SubScraper Auth Harvest — content script (corre en onlyfans.com).
//
// Su unico trabajo: avisar al background que el usuario ENTRO al
// sitio, pasandole las dos piezas que solo existen en el contexto de
// la pagina: el token bcTokenSha (localStorage) y el User-Agent real
// del navegador. Las cookies de sesion NO se leen aca: sess es
// HttpOnly y un script de pagina no la ve; eso lo hace el background
// con la API de cookies de la extension.
//
// El token puede tardar unos segundos en generarse tras el login (lo
// escribe el JS del sitio cuando el feed levanta), asi que se polea
// el localStorage hasta ~40 s antes de avisar, igual que la cosecha
// de escritorio espera a que la sesion se asiente.
(function () {
  "use strict";

  var TOKEN_KEY = "bcTokenSha";
  var POLL_MS = 2000;
  var MAX_TRIES = 20; // ~40 s de poleo rapido
  var SLOW_POLL_MS = 10000; // despues, poleo lento sin rendirse
  var sentToken = false;
  var sentEmpty = false;

  function readToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function notify(xBc) {
    try {
      chrome.runtime.sendMessage({
        type: "page-ready",
        xBc: xBc,
        ua: navigator.userAgent || "",
      });
    } catch (e) {
      // Extension recargada o contexto invalidado: no hay a quien
      // avisar; la proxima entrada reintenta.
    }
  }

  // Dos avisos posibles, con guardas separadas (auditoria): el
  // aviso VACIO es solo diagnostico (el background lo registra como
  // sin-token y no marca nada), y el aviso con token es el disparo
  // real. Agotar la ventana rapida NO deja mudo al script: el sitio
  // es una SPA y el login (con 2FA puede tardar mas de 40 s) no
  // recarga el documento, asi que se sigue poleando lento hasta que
  // el token aparezca; recien ahi se manda el disparo real.
  var tries = 0;
  function tick() {
    if (sentToken) {
      return;
    }
    var token = readToken();
    if (token) {
      sentToken = true;
      notify(token);
      return;
    }
    tries += 1;
    if (tries === MAX_TRIES && !sentEmpty) {
      sentEmpty = true;
      notify("");
    }
    setTimeout(tick, tries < MAX_TRIES ? POLL_MS : SLOW_POLL_MS);
  }
  tick();

  // Sonda/forzado desde el popup (via background): responde en el
  // momento con lo que haya, sin esperar el poleo.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "probe") {
      sendResponse({ xBc: readToken(), ua: navigator.userAgent || "" });
    }
    return false;
  });
})();
