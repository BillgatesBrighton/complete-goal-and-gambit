/* GOAL$GAMBIT shared page script: mobile menu + logged-in nav */
(function () {
    "use strict";

    var menuButton = document.getElementById("menuButton");
    var mobileMenu = document.getElementById("mobileMenu");

    if (menuButton && mobileMenu) {
        menuButton.addEventListener("click", function () {
            var open = mobileMenu.classList.toggle("open");
            menuButton.setAttribute("aria-expanded", open ? "true" : "false");
        });

        mobileMenu.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function () {
                mobileMenu.classList.remove("open");
            });
        });
    }

    // If logged in, hide Log In / Create Account and show Dashboard.
    var loggedIn = !!localStorage.getItem("goalGambitToken");
    document.querySelectorAll(".login-button, .signup-button, .mobile-signup").forEach(function (el) {
        if (loggedIn) el.style.display = "none";
    });
    document.querySelectorAll('.mobile-menu a[href="login.html"]').forEach(function (el) {
        if (loggedIn) el.style.display = "none";
    });
    document.querySelectorAll(".dashboard-button").forEach(function (el) {
        if (!loggedIn) el.style.display = "none";
    });
})();
