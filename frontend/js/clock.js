/* =========================================================
   GOAL$GAMBIT CHESS CLOCK
========================================================= */

let whiteTime =
    selectedTime.minutes * 60;

let blackTime =
    selectedTime.minutes * 60;

let clockInterval = null;


/* =========================================================
   FORMAT TIME
========================================================= */

function formatClock(seconds) {

    seconds =
        Math.max(
            0,
            Math.floor(seconds)
        );


    const minutes =
        Math.floor(
            seconds / 60
        );


    const remainingSeconds =
        seconds % 60;


    return (
        String(minutes)
            .padStart(2, "0")
        +
        ":"
        +
        String(remainingSeconds)
            .padStart(2, "0")
    );

}


/* =========================================================
   UPDATE DISPLAY
========================================================= */

function updateClockDisplay() {

    const whiteClock =
        document.getElementById(
            "userClock"
        );

    const blackClock =
        document.getElementById(
            "opponentClock"
        );


    if (playerColor === "w") {

        whiteClock.textContent =
            formatClock(
                whiteTime
            );

        blackClock.textContent =
            formatClock(
                blackTime
            );

    } else {

        whiteClock.textContent =
            formatClock(
                whiteTime
            );

        blackClock.textContent =
            formatClock(
                blackTime
            );

    }


    whiteClock.classList.toggle(
        "active-clock",
        currentTurn === "w"
    );


    blackClock.classList.toggle(
        "active-clock",
        currentTurn === "b"
    );

}


/* =========================================================
   CLOCK TICK
========================================================= */

function startClock() {

    if (clockInterval) {
        clearInterval(
            clockInterval
        );
    }


    clockInterval =
        setInterval(
            function() {

                if (gameOver) {

                    clearInterval(
                        clockInterval
                    );

                    return;
                }


                if (currentTurn === "w") {

                    whiteTime--;

                    if (
                        whiteTime <= 0
                    ) {

                        whiteTime = 0;

                        clearInterval(
                            clockInterval
                        );

                        gameOver = true;

                        finishGame(
                            playerColor === "w"
                                ? "You lost on time."
                                : "You win on time."
                        );

                    }

                } else {

                    blackTime--;

                    if (
                        blackTime <= 0
                    ) {

                        blackTime = 0;

                        clearInterval(
                            clockInterval
                        );

                        gameOver = true;

                        finishGame(
                            playerColor === "b"
                                ? "You lost on time."
                                : "You win on time."
                        );

                    }

                }


                updateClockDisplay();

            },
            1000
        );

}


/* =========================================================
   INITIALIZE
========================================================= */

updateClockDisplay();

startClock();