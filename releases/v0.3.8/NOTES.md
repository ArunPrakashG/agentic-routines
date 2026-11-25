# 0.3.8

## Fixes
- Clicks no longer bring Chrome to the front while you work in another window. Some window managers (Hyprland, X11 ones) raised the browser on every click a routine or agent made in a tab its window was showing.
- In that case a click on a button, link, checkbox or radio is made with the Enter or Space key, so the page still gets a real click. Other clicks and drags there use page events.
