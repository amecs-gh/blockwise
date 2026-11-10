# The page calls these through the JavaScript bridge
-keepclassmembers class app.tracker.android.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
