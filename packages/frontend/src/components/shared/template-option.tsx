import { TextInput } from '../ui/text-input';
import { NumberInput } from '../ui/number-input';
import { Switch } from '../ui/switch';
import { Select } from '../ui/select';
import { Combobox } from '../ui/combobox';
import { Option } from '@aiostreams/core';
import React, { useState } from 'react';
import MarkdownLite from './markdown-lite';
import { Alert } from '../ui/alert';
import { SocialIcon } from './social-icon';
import { PasswordInput } from '../ui/password-input';
import { Button } from '../ui/button';
import { IconButton } from '../ui/button';
import { ArrowLeftIcon, KeyIcon } from 'lucide-react';
// this component, accepts an option and returns a component that renders the option.
// string - TextInput
// number - NumberInput
// boolean - Checkbox
// select - Select
// multi-select - ComboBox
// url - TextInput (with url validation)

// Props for the template option component
interface TemplateOptionProps {
  option: Option;
  value: any;
  disabled?: boolean;
  onChange: (value: any) => void;
}

const TemplateOption: React.FC<TemplateOptionProps> = ({
  option,
  value,
  onChange,
  disabled,
}) => {
  const {
    id,
    name,
    description,
    type,
    required,
    options,
    constraints,
    forced,
    default: defaultValue,
    intent,
    socials,
    oauth,
    emptyIsUndefined = false,
  } = option;

  const isDisabled = disabled || !!forced;

  switch (type) {
    case 'socials':
      return (
        <div className="flex items-center justify-center w-full gap-6 mt-2">
          {socials?.map((social) => (
            <SocialIcon key={social.id} id={social.id} url={social.url} />
          ))}
        </div>
      );
    case 'alert':
      return (
        <Alert
          intent={intent}
          title={name}
          description={<MarkdownLite>{description}</MarkdownLite>}
        />
      );
    case 'password':
      return (
        <div>
          <PasswordInput
            label={name}
            value={forced || defaultValue || value}
            onValueChange={(value: string) =>
              onChange(emptyIsUndefined ? value || undefined : value)
            }
            required={required}
            disabled={isDisabled}
            minLength={
              constraints?.forceInUi !== false ? constraints?.min : undefined
            }
            maxLength={
              constraints?.forceInUi !== false ? constraints?.max : undefined
            }
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'string':
      return (
        <div>
          <TextInput
            label={name}
            value={value}
            onValueChange={(value: string) =>
              onChange(emptyIsUndefined ? value || undefined : value)
            }
            required={required}
            minLength={
              constraints?.forceInUi !== false ? constraints?.min : undefined
            }
            maxLength={
              constraints?.forceInUi !== false ? constraints?.max : undefined
            }
            disabled={isDisabled}
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'number':
      return (
        <div>
          <NumberInput
            value={value}
            label={name}
            onValueChange={(value: number, valueAsString: string) =>
              onChange(value)
            }
            required={required}
            step={
              constraints?.max
                ? Math.floor(constraints?.max / 100) > 0
                  ? Math.floor(constraints?.max / 100)
                  : 1
                : 1
            }
            disabled={isDisabled}
            min={
              constraints?.forceInUi !== false ? constraints?.min : undefined
            }
            max={
              constraints?.forceInUi !== false ? constraints?.max : undefined
            }
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'boolean':
      return (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-sm">{name}</span>
            <Switch value={!!value} onValueChange={onChange} />
          </div>
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'select':
      return (
        <div>
          <Select
            label={name}
            value={value}
            onValueChange={onChange}
            options={
              options?.map((opt) => ({ label: opt.label, value: opt.value })) ??
              []
            }
            required={required}
            disabled={isDisabled}
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">{description}</div>
          )}
        </div>
      );
    case 'multi-select':
      return (
        <div>
          <Combobox
            label={name}
            value={Array.isArray(value) ? value : undefined}
            onValueChange={(value: any) =>
              onChange(
                emptyIsUndefined
                  ? value?.length === 0
                    ? undefined
                    : value
                  : value
              )
            }
            options={
              options?.map((opt) => ({
                label: opt.label,
                value: opt.value,
                textValue: opt.label,
              })) ?? []
            }
            multiple
            emptyMessage="No options"
            disabled={isDisabled}
            required={required}
            maxItems={
              constraints?.forceInUi !== false ? constraints?.max : undefined
            }
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'url':
      return (
        <div>
          <TextInput
            label={name}
            value={value}
            onValueChange={(value: string) =>
              onChange(emptyIsUndefined ? value || undefined : value)
            }
            required={required}
            type="url"
            disabled={isDisabled}
            minLength={
              constraints?.forceInUi !== false ? constraints?.min : undefined
            }
            maxLength={
              constraints?.forceInUi !== false ? constraints?.max : undefined
            }
          />
          {description && (
            <div className="text-xs text-[--muted] mt-1">
              <MarkdownLite>{description}</MarkdownLite>
            </div>
          )}
        </div>
      );
    case 'oauth': {
      const [showInput, setShowInput] = useState(!!value);

      if (!showInput) {
        return (
          <div>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 bg-[--subtle] p-4 rounded-lg">
                <div className="flex-1">
                  <h4 className="font-medium mb-1">{name}</h4>
                  <p className="text-sm text-[--muted]">
                    <MarkdownLite>{description}</MarkdownLite>
                  </p>
                </div>
                <IconButton
                  icon={<KeyIcon />}
                  intent="primary-outline"
                  onClick={() => {
                    window.open(oauth?.authorisationUrl || '', '_blank');
                    setShowInput(true);
                  }}
                  className="shrink-0"
                />
              </div>
            </div>
          </div>
        );
      }

      return (
        <div>
          <div className="flex flex-col gap-3">
            <div className="bg-[--subtle] p-4 rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-medium">
                  Enter {oauth?.oauthResultField?.name || 'Authorization Code'}
                </h4>
                <IconButton
                  icon={<ArrowLeftIcon className="w-4 h-4" />}
                  intent="primary-subtle"
                  size="sm"
                  onClick={() => setShowInput(false)}
                  aria-label="Go back to authorization"
                />
              </div>
              <PasswordInput
                value={value}
                onValueChange={(value: string) =>
                  onChange(emptyIsUndefined ? value || undefined : value)
                }
                required={required}
                disabled={isDisabled}
              />
              {oauth?.oauthResultField?.description && (
                <div className="text-sm text-[--muted] mt-2">
                  <MarkdownLite>
                    {oauth.oauthResultField.description}
                  </MarkdownLite>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
};

export default TemplateOption;
