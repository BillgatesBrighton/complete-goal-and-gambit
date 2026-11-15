(function () {
    "use strict";

    var deferredInstallPrompt = null;
    var installButton = null;

    function isInstalled() {
        return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
            window.navigator.standalone === true;
    }

    function installInstructions() {
        var userAgent = navigator.userAgent || "";
        var isIOS = /iphone|ipad|ipod/i.test(userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        var isAndroid = /android/i.test(userAgent);

        if (isIOS) {
            return "On your iPhone or iPad, open this page in Safari, tap the Share button, choose Add to Home Screen, then tap Add. The website remains available in Safari too.";
        }
        if (isAndroid) {
            return "Open your browser menu and choose Install app or Add to Home screen. If that option is not shown, open this page in Chrome and try again.";
        }
        return "Open your browser menu and choose Install GOAL$GAMBIT or Install app. In Chrome or Edge, you can also use the install icon at the right side of the address bar.";
    }

    function showInstallHelp() {
        var dialog = document.getElementById("pwaInstallHelp");
        if (!dialog) {
            dialog = document.createElement("dialog");
            dialog.id = "pwaInstallHelp";
            dialog.setAttribute("aria-labelledby", "pwaInstallTitle");
            dialog.innerHTML = "<style>" +
                "#pwaInstallHelp{width:min(92vw,440px);padding:28px;border:1px solid rgba(244,189,32,.45);border-radius:18px;background:#111;color:#fff;box-shadow:0 24px 80px #000b;font:16px/1.6 Arial,sans-serif}" +
                "#pwaInstallHelp::backdrop{background:rgba(0,0,0,.72)}" +
                "#pwaInstallHelp h2{margin:0 0 12px;color:#f4bd20;font-size:22px}" +
                "#pwaInstallHelp p{margin:0 0 20px;color:#ddd}" +
                "#pwaInstallHelp button{padding:11px 22px;border:0;border-radius:8px;background:#f4bd20;color:#111;font-weight:800;cursor:pointer}" +
                "</style><h2 id=\"pwaInstallTitle\">Install GOAL$GAMBIT</h2>" +
                "<p id=\"pwaInstallInstructions\"></p><button type=\"button\">Got it</button>";
            document.body.appendChild(dialog);
            dialog.querySelector("button").addEventListener("click", function () {
                dialog.close();
            });
            dialog.addEventListener("click", function (event) {
                if (event.target === dialog) dialog.close();
            });
        }

        dialog.querySelector("#pwaInstallInstructions").textContent = installInstructions();
        if (typeof dialog.showModal === "function") dialog.showModal();
        else window.alert(installInstructions());
    }

    function addInstallButton() {
        var actions = document.querySelector(".hero-actions");
        if (!actions || document.getElementById("pwaInstallButton")) return;

        installButton = document.createElement("button");
        installButton.id = "pwaInstallButton";
        installButton.type = "button";
        installButton.className = "secondary-button";
        installButton.textContent = "Install Web App";
        installButton.setAttribute("aria-label", "Install GOAL$GAMBIT as an app");
        installButton.style.fontFamily = "inherit";
        installButton.style.cursor = "pointer";
        installButton.addEventListener("click", async function () {
            if (isInstalled()) {
                installButton.textContent = "App Installed";
                installButton.disabled = true;
                return;
            }

            if (!deferredInstallPrompt) {
                showInstallHelp();
                return;
            }

            var promptEvent = deferredInstallPrompt;
            deferredInstallPrompt = null;
            try {
                await promptEvent.prompt();
                var choice = await promptEvent.userChoice;
                if (choice && choice.outcome === "accepted") installButton.textContent = "Installing…";
            } catch (error) {
                console.warn("GOAL$GAMBIT app install prompt failed.", error);
                showInstallHelp();
            }
        });

        var androidDownload = actions.querySelector('a[href*="goal-gambit-player-"]');
        if (androidDownload) androidDownload.insertAdjacentElement("afterend", installButton);
        else actions.appendChild(installButton);

        if (isInstalled()) {
            installButton.textContent = "App Installed";
            installButton.disabled = true;
        }
    }

    window.addEventListener("beforeinstallprompt", function (event) {
        event.preventDefault();
        deferredInstallPrompt = event;
    });

    window.addEventListener("appinstalled", function () {
        deferredInstallPrompt = null;
        if (installButton) {
            installButton.textContent = "App Installed";
            installButton.disabled = true;
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", addInstallButton, { once: true });
    } else {
        addInstallButton();
    }

    if ("serviceWorker" in navigator && window.isSecureContext) {
        var workerUrl = new URL("../sw.js", window.location.href);
        var scopeUrl = new URL("../", window.location.href);
        navigator.serviceWorker.register(workerUrl.href, { scope: scopeUrl.pathname }).catch(function (error) {
            console.warn("GOAL$GAMBIT offline app support could not be registered.", error);
        });
    }
})();
