package com.goalgambit.trial;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** Displays approved public help and legal pages inside the player app. */
public final class PlayerWebPageActivity extends Activity {
    static final String EXTRA_PAGE = "player_web_page";
    private static final String ROOT = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/";
    private WebView web;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        String page = getIntent().getStringExtra(EXTRA_PAGE);
        String file;
        String title;
        if ("how-it-works".equals(page)) { file = "how-it-works.html"; title = "How it works"; }
        else if ("terms".equals(page)) { file = "terms.html"; title = "Terms & Conditions"; }
        else if ("privacy".equals(page)) { file = "privacy.html"; title = "Privacy Policy"; }
        else if ("password-recovery".equals(page)) { file = "password-recovery.html"; title = "Password recovery"; }
        else if ("contact".equals(page)) { file = "contact.html"; title = "Contact GOAL$GAMBIT"; }
        else { finish(); return; }

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.rgb(8, 8, 8));
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(10), dp(6), dp(10), dp(6));
        Button back = new Button(this);
        back.setText("‹  BACK");
        back.setAllCaps(false);
        back.setTextColor(Color.rgb(244, 189, 32));
        back.setOnClickListener(v -> finish());
        bar.addView(back, new LinearLayout.LayoutParams(-2, dp(44)));
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(15);
        heading.setGravity(Gravity.CENTER);
        bar.addView(heading, new LinearLayout.LayoutParams(0, -2, 1f));
        shell.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        boolean recoveryPage = "password-recovery".equals(page);
        settings.setJavaScriptEnabled(recoveryPage);
        settings.setDomStorageEnabled(recoveryPage);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setBackgroundColor(Color.rgb(8, 8, 8));
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) &&
                    "billgatesbrighton.github.io".equalsIgnoreCase(uri.getHost()) &&
                    uri.getPath() != null && uri.getPath().startsWith("/complete-goal-and-gambit/frontend/pages/")) return false;
                openExternal(uri);
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if ("https".equalsIgnoreCase(uri.getScheme()) &&
                    "billgatesbrighton.github.io".equalsIgnoreCase(uri.getHost()) &&
                    uri.getPath() != null && uri.getPath().startsWith("/complete-goal-and-gambit/frontend/pages/")) return false;
                openExternal(uri);
                return true;
            }
        });
        shell.addView(web, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(shell, new ViewGroup.LayoutParams(-1, -1));
        web.loadUrl(ROOT + file);
    }

    private void openExternal(Uri uri) {
        if (uri == null || !("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (RuntimeException error) { Toast.makeText(this, "This link could not be opened.", Toast.LENGTH_SHORT).show(); }
    }

    @Override protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
