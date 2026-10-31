# 内置模型推理档位

后台添加或编辑内置模型时，勾选供应商实际支持的强度，并为已勾选项填写显示名称、选择默认档位。显示名称留空使用“低、中、高、超高、极致、Ultra”；名称不改变供应商参数。取消当前默认档位后，需要重新指定默认项才能保存。

配置存于现有 `capabilities_json` 的 `efforts`、`effort_labels` 和 `default_effort`，随客户端公开配置下发，不需要数据库表结构迁移。旧模型没有默认值时，优先使用 `high`，否则使用支持的最高档位。

客户端按模型分别记住 Work、Chat 选择。失效选择回到后台默认档位；没有强度档位时只控制思考开启状态，供应商请求不携带强度参数。Chat 对可关闭模型提供“不思考”，Work 禁止主动关闭思考；不支持思考的模型禁用调节。

新请求带 `reasoningProfileVersion: 2`，强度参数保持原值。旧请求继续使用原映射；旧客户端本地选择和会话快照在恢复时迁移到真实参数。更新时先部署后台，再更新客户端及运行时。

相关验证：后端 `builtin_reasoning_test.php`、`membership_test.php`；运行时 `builtin-reasoning.test.mjs`、`desktop-gateway.test.mjs`、`builtin-proxy.test.mjs`；前端 `builtin-reasoning.test.mjs`、`offline.test.mjs`、`process.test.mjs`。浏览器截图输出到前端 `artifacts/builtin-reasoning/`。
