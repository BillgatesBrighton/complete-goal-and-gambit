package com.goalgambit.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class HelpActivity extends Activity {
    private LinearLayout root;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(8, 8, 8));
        getWindow().setNavigationBarColor(Color.rgb(8, 8, 8));
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(8, 8, 8));
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, dp(24), pad, dp(28));
        scroll.addView(root);
        setContentView(scroll);

        root.addView(text("HELP & FAQ", 23, Color.rgb(237, 195, 53), true));
        root.addView(text("Quick answers from the GOAL$GAMBIT setup and match guidance. If your situation is not covered, contact the support team.", 14, Color.LTGRAY, false), margins(-1, -2, 0, 7, 0, 14));

        addFaq("How do I deposit?", "Open GOAL$GAMBIT on the website, choose Wallet, then Deposit. Follow the payment instructions and wait for the website to confirm the deposit before joining a paid competition.");
        addFaq("How do I join a competition?", "Check the competition rules and entry fee on the website, confirm your available wallet funds, then join from its competition page. The Companion does not take payments or bypass entry requirements.");
        addFaq("How do I send an eFootball room code?", "GOAL$GAMBIT selects the sender for each match. If you are selected, open the room in eFootball and reply to the GOAL$GAMBIT notification. The inline reply sends the code to your matched opponent only.");
        addFaq("How do I confirm a result?", "Open the Match Hub on the website and follow the result-submission steps for your match. Submit the result shown in the game and use the dispute process if the two players disagree.");
        addFaq("How do I enable notifications?", "Allow GOAL$GAMBIT Companion notifications in Android Settings. You can choose notification categories here, but Android's permission and channel settings still control whether alerts appear.");
        addFaq("Where are maintenance updates?", "When administrators publish a maintenance or service announcement, read its full details in the Companion's Announcements section. Support remains available when its service is online.");
        addFaq("Can I see my full fixtures here?", "The Companion shows a short upcoming-games summary. Open Match Hub on the website for the match details and actions available to your account.");

        Button support = button("CONTACT SUPPORT");
        support.setOnClickListener(view -> {
            Intent intent = new Intent(this, MainActivity.class)
                .putExtra(Notifications.EXTRA_OPEN_SUPPORT, true)
                .putExtra("supportCategory", "suggestion");
            startActivity(intent);
        });
        root.addView(support, margins(-1, -2, 0, 8, 0, 8));

        Button matchHub = button("OPEN MATCH HUB");
        matchHub.setOnClickListener(view -> startActivity(new Intent(Intent.ACTION_VIEW,
            Uri.parse("https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/match-hub.html"))));
        root.addView(matchHub, margins(-1, -2, 0, 0, 0, 0));
    }

    private void addFaq(String question, String answer) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(10), dp(12), dp(10));
        card.setBackgroundColor(Color.rgb(24, 24, 24));
        TextView title = text(question, 15, Color.rgb(237, 195, 53), true);
        TextView detail = text(answer, 14, Color.WHITE, false);
        detail.setVisibility(View.GONE);
        card.addView(title);
        card.addView(detail, margins(-1, -2, 0, 7, 0, 0));
        card.setOnClickListener(view -> detail.setVisibility(detail.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        root.addView(card, margins(-1, -2, 0, 0, 0, 8));
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextColor(Color.rgb(18, 18, 18));
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(237, 195, 53)));
        return button;
    }

    private LinearLayout.LayoutParams margins(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
