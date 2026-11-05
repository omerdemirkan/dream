Pod::Spec.new do |s|
  s.name           = 'DreamLiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'Live Activity tokens for Dream'
  s.description    = 'Reports ActivityKit push-to-start and update tokens for DreamActivityAttributes to JavaScript.'
  s.author         = 'Dream'
  s.homepage       = 'https://dream.omer.build'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
