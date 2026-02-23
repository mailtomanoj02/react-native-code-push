module.exports = {
    dependency: {
        platforms: {
            android: {
                packageImportPath: 'import com.microsoft.codepush.react.CodePush;',
                packageInstance:
                    'CodePush.getInstance(getResources().getString(R.string.CodePushDeploymentKey), getResources().getString(R.string.CodePushServerUrl), getApplicationContext(), BuildConfig.DEBUG)',
                sourceDir: './android/app'
            },
            ios: {
                podspecPath: './CodePush.podspec'
            }
        }
    }
};
