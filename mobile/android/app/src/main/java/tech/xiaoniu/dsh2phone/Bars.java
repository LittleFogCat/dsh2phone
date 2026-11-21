package tech.xiaoniu.dsh2phone;

import android.content.res.Configuration;
import android.view.View;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** 非 WebView 页面统一处理 edge-to-edge 的系统栏 padding，避免内容顶到状态栏下。 */
final class Bars {
    private Bars() {
    }

    static void apply(AppCompatActivity activity, View root) {
        WindowCompat.setDecorFitsSystemWindows(activity.getWindow(), false);
        int color = ContextCompat.getColor(activity, R.color.app_background);
        activity.getWindow().setStatusBarColor(color);
        activity.getWindow().setNavigationBarColor(color);
        boolean lightIcons = (activity.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(lightIcons);
            controller.setAppearanceLightNavigationBars(lightIcons);
        }
        paintSystemBarBackgrounds(activity, color);
        int flags = activity.getWindow().getDecorView().getSystemUiVisibility();
        if (lightIcons) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        } else {
            flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        activity.getWindow().getDecorView().setSystemUiVisibility(flags);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(
                    Math.max(bars.left, cut.left),
                    Math.max(bars.top, cut.top),
                    Math.max(bars.right, cut.right),
                    Math.max(bars.bottom, ime.bottom));
            return insets;
        });
        ViewCompat.requestApplyInsets(root);
    }

    static void paintSystemBarBackgrounds(android.app.Activity activity, int color) {
        View decor = activity.getWindow().getDecorView();
        View status = decor.findViewById(android.R.id.statusBarBackground);
        if (status != null) status.setBackgroundColor(color);
        View nav = decor.findViewById(android.R.id.navigationBarBackground);
        if (nav != null) nav.setBackgroundColor(color);
    }
}
