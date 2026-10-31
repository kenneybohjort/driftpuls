// Läser sparat tema direkt (laddas i <head> så sidan inte blinkar i fel tema)
(function () { try { var t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.classList.add(t); } catch (e) {} })();
