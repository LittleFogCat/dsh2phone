# zxing-android-embedded 通过反射/Intent 拉起扫描页，类名不能被 R8 改写。
-keep class com.journeyapps.barcodescanner.** { *; }
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**

# WebView 的 JavaScript 与 Material 组件不需要额外规则；保留注解便于后续扩展。
-keepattributes *Annotation*
