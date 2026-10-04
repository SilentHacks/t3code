import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import type { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";
import {
  mobileOmpInstances,
  mobileOmpSettingsPatch,
  nextMobileOmpInstanceId,
} from "./omp-settings";

export function OmpProviderSettings({ environment }: { readonly environment: SettingsTarget }) {
  const settings = environment.serverConfig.settings;
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: true,
    label: "OMP settings update",
  });
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const instances = mobileOmpInstances(settings);
  function save(id: ProviderInstanceId, patch: Partial<OmpSettings>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    void update({
      environmentId: environment.environmentId,
      input: { patch: mobileOmpSettingsPatch(settings, id, patch) },
    }).finally(() => {
      busy.current = false;
      setPending(false);
    });
  }
  return (
    <View>
      <Text className="p-4 text-sm text-foreground-muted">
        Install and sign in to OMP on {environment.label}. Profiles and executable paths refer to
        that environment, not this phone.
      </Text>
      {instances.map((instance) => (
        <View key={instance.id} className="border-b border-border-subtle">
          <SettingsSwitchRow
            icon="terminal"
            label={`${instance.displayName} (${instance.id})`}
            subtitle="Enable Oh My Pi for new threads"
            value={instance.enabled}
            disabled={pending}
            onValueChange={(enabled) => save(instance.id, { enabled })}
          />
          <View className="gap-3 p-4">
            <OmpSettingField
              key={`${instance.id}:binary:${instance.config.binaryPath}`}
              label="OMP executable"
              value={instance.config.binaryPath}
              placeholder="omp"
              disabled={pending}
              save={(binaryPath) => save(instance.id, { binaryPath })}
            />
            <OmpSettingField
              key={`${instance.id}:profile:${instance.config.profile}`}
              label="OMP profile"
              value={instance.config.profile}
              placeholder="Default profile"
              disabled={pending}
              save={(profile) => save(instance.id, { profile })}
            />
          </View>
        </View>
      ))}
      <SettingsActionRow
        icon="plus"
        label="Add Oh My Pi provider"
        disabled={pending}
        onPress={() => save(nextMobileOmpInstanceId(settings), { enabled: true })}
      />
    </View>
  );
}

function OmpSettingField(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly save: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        placeholder={props.placeholder}
        value={value}
        onChangeText={setValue}
        onEndEditing={() => {
          if (value.trim() !== props.value) props.save(value.trim());
        }}
      />
    </View>
  );
}
