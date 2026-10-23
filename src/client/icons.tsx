/** ic_ds_* glyphs inlined from @deepseek-ai/dsh-client-ui-primitives (MIT). */
interface IconProps {
  size?: number
  className?: string
}

export function IconPinwheel({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden>
      <path d="M7.84457 5.06199C11.6605 4.93876 14.7962 6.14848 14.8484 7.76397C14.8875 8.97461 13.1838 10.0696 10.7215 10.5942" stroke="currentColor" />
      <path d="M5.12742 8.07731C5.00419 4.26138 6.21391 1.12568 7.8294 1.07351C9.04004 1.03441 10.135 2.73808 10.6596 5.20037" stroke="currentColor" />
      <path d="M8.02457 10.6802C4.20865 10.8034 1.07294 9.5937 1.02077 7.97821C0.981678 6.76758 2.68535 5.67262 5.14763 5.14798" stroke="currentColor" />
      <path d="M10.7476 7.89535C10.8708 11.7113 9.66109 14.847 8.0456 14.8991C6.83496 14.9382 5.74 13.2346 5.21536 10.7723" stroke="currentColor" />
    </svg>
  )
}

export function IconPlug({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden>
      <path d="M5.25 1.75V4.5M10.75 1.75V4.5" stroke="currentColor" strokeLinecap="round" />
      <path d="M4 4.5H12V7.25C12 9.45914 10.2091 11.25 8 11.25C5.79086 11.25 4 9.45914 4 7.25V4.5Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M8 11.25V14.25" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

const CONTEXT7_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEoAAABLCAYAAADXjBHUAAAACXBIWXMAAAsTAAALEwEAmpwYAAABaWlDQ1BEaXNwbGF5IFAzAAB4nHWQvUvDUBTFT6tS0DqIDh0cMolD1NIKdnFoKxRFMFQFq1OafgltfCQpUnETVyn4H1jBWXCwiFRwcXAQRAcR3Zw6KbhoeN6XVNoi3sfl/Ticc7lcwBtQGSv2AijplpFMxKS11Lrke4OHnlOqZrKooiwK/v276/PR9d5PiFlNu3YQ2U9cl84ul3aeAlN//V3Vn8maGv3f1EGNGRbgkYmVbYsJ3iUeMWgp4qrgvMvHgtMunzuelWSc+JZY0gpqhrhJLKc79HwHl4plrbWD2N6f1VeXxRzqUcxhEyYYilBRgQQF4X/8044/ji1yV2BQLo8CLMpESRETssTz0KFhEjJxCEHqkLhz634PrfvJbW3vFZhtcM4v2tpCAzidoZPV29p4BBgaAG7qTDVUR+qh9uZywPsJMJgChu8os2HmwiF3e38M6Hvh/GMM8B0CdpXzryPO7RqFn4Er/QcXKWq8MSlPPgAABA5JREFUeAHtmzFME2EUgB+GQXCgGCSBpeiICRjERROKoYtG4kANC6kDasLCAgNLO+BcBxgYxIHiZhkgRJcahcgmJB1k1HaBBBLtomHTezXVu/+u9N3de03Q9yUM/cPlb7/+79279/9tap4bfwdKXZqtv2FQ6nIOFBIqioiKIqKiiKgoIiqKiIoioqKIqCgiKoqIiiKioog0Q0hil3th+cEU+GX78z5M5pZ8XZObmIX+7ij4JbGagcJhEcIQWhTS034J/FIKcE2kpTXQXHhdWDT0iKgoIqFDr3BYguK3Y0dIlKzXK7tbp16H/+OX7N4WbFm57TSS12Ou9xJkLpPQoson3+GRlZTzj9N/xqLWGy2f/IDFndfASbaO/NRIwpXDxl5mKl9kWFhCD7/lmc2sY+zZvSTErvRCo+jv7oF0POEYe/o2B4WDInDAlqMWrNVjhsWLxBREzl8AaXCO3MSMY2x9/yPM53PABWsyx7oIQ64KhmAqPgbS4BxmyM1urgAnrKIwaS58cOal6Vt3ob+rB6TALwPnsIMhx5GX7LCXB4s7bxyrCslY+UqK9EjCNVYv6QeBXRTeBbO77x1jmNQlVhWuJiwH7KAk7tWEiBScG1YiNUkODAE3nqtpj381ISKiCgclV/glB4eBmyGP8qNeQRoUEVEYfqWvR46xyPlW1roKuxbmnU5KEiL2rIePNiZ9jHmqzyowTUoCuamKmCivhHqty38vqRa4oihzciEmqlR2v+kgTbdaePWYzuSK8oLzcSYaoIEXhoaKamvhExVpkX+GtNPUPDf+E5S6aIeTiIoioqKIqCgiKooIywaoF1jneFXPXE/3yYGYa2z7y75YdS4mCh+AsWduBytnLlGpuHvHZfLVkiXqDLVZ/kXERLV5PK5whgX2vFxzClbrYqJ62jtcY1x7bEipfOSeM9IBUoiJikY6XWOYbLnw6ndFL3aCFGKivFoqXh8uKBuf3H15zn6XiYgoLA282rScOQrbzWbrtzJvRKb9IiLKqzcusde27rHbM3r1BkggImr65h3Ha876yc6qJd/c7bnfOwgSsIvCarzfaPxzHpawg+FnbuHjapY4RcMuytw+l1pNVXAL38x9KY+N0bCwisLt7UatpirVg2x2cEV5PQuGgU1U5YiP8U3iiTvJ1VQF737m6b7M6MNAJ4hrwSZqbWLGdXZyPr8GjQLnsocg7kwvJ/yff68FiyhcSfaQQ0nx5/OVsGgUONfvOf/eBTEEuY4chd6Fwbtc/kna93UYLvjB/IAHaoPc0QYX5kL/cuG/aLPoLxcaiIoiEroVXCwfB6qVpH65wDWXiW6pE9HQI6KiiKgoIiqKiIoioqKIqCgiKoqIiiKiooioKCIqiojVPWi6DUpdfgE8wFukKedIwQAAAABJRU5ErkJggg=='

export function BrandGithub({ size = 22, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  )
}

export function BrandGitlab({ size = 22, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#e24329" d="M12 22.186l4.42-13.605H7.58L12 22.186z" />
      <path fill="#fc6d26" d="M12 22.186L7.58 8.581H1.65L12 22.186z" />
      <path fill="#fca326" d="M1.65 8.581L.167 13.145a.916.916 0 00.333 1.026L12 22.186 1.65 8.581z" />
      <path fill="#e24329" d="M1.65 8.581h5.93L5.033.927a.458.458 0 00-.872 0L1.65 8.581z" />
      <path fill="#fc6d26" d="M12 22.186l4.42-13.605h5.93L12 22.186z" />
      <path fill="#fca326" d="M22.35 8.581l1.483 4.564a.916.916 0 01-.333 1.026L12 22.186 22.35 8.581z" />
      <path fill="#e24329" d="M22.35 8.581h-5.93l2.547-7.654a.458.458 0 01.872 0l2.511 7.654z" />
    </svg>
  )
}

export function BrandContext7({ size = 22, className }: IconProps): JSX.Element {
  return <img width={size} height={size} className={className} src={CONTEXT7_ICON} alt="" />
}

export function IconLink({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z"
      />
      <path
        fill="currentColor"
        d="M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z"
      />
    </svg>
  )
}

export function IconCopy({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.75" y="5.75" width="7.5" height="8" rx="1.5" stroke="currentColor" strokeWidth="1" />
      <path
        d="M10.75 4.25V3.5A1.5 1.5 0 0 0 9.25 2h-5A1.5 1.5 0 0 0 2.75 3.5v6a1.5 1.5 0 0 0 1.5 1.5h.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconClose({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

export function IconCheck({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.2 8.4L6.4 11.6L12.8 4.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconAlert({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1" />
      <path d="M8 4.6V8.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11.2" r="0.7" fill="currentColor" />
    </svg>
  )
}

export function IconMore({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.5" cy="8" r="1" />
    </svg>
  )
}

export function IconPlay({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4.6 3.2L12.2 8L4.6 12.8V3.2Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

export function IconTrash({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.2 4.6H12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M6.2 4.6V3.2H9.8V4.6" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M4.6 4.6L5.2 13H10.8L11.4 4.6" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6.8 7V11M9.2 7V11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

export function IconChevronDown({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconChevronRight({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconSearch({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z"
      />
      <path fill="currentColor" d="M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z" />
    </svg>
  )
}

export function IconPlus({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path fill="currentColor" d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" />
    </svg>
  )
}

export function IconRefresh({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z"
      />
    </svg>
  )
}

export function IconCode({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z"
      />
    </svg>
  )
}

export function IconGlobe({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M7.00018 0.353516C10.6708 0.353535 13.6468 3.32958 13.6469 7.00018C13.6468 10.6708 10.6708 13.6468 7.00018 13.6469C3.32957 13.6468 0.353535 10.6708 0.353516 7.00018C0.353535 3.32957 3.32957 0.353531 7.00018 0.353516ZM5.44643 7.59661C5.49463 8.97506 5.70762 10.191 6.02136 11.0793C6.20141 11.5891 6.40328 11.9585 6.59898 12.1889C6.79501 12.4196 6.93213 12.454 7.00018 12.454C7.06822 12.454 7.20533 12.4197 7.40138 12.1889C7.59708 11.9585 7.79895 11.589 7.979 11.0793C8.29274 10.191 8.50574 8.97506 8.55394 7.59661H5.44643ZM1.57861 7.59661C1.80785 9.70467 3.2386 11.4509 5.1715 12.1388C5.07135 11.9317 4.97972 11.7098 4.89746 11.477C4.53084 10.4391 4.30224 9.0828 4.25357 7.59661H1.57861ZM9.74679 7.59661C9.69813 9.0828 9.46952 10.4391 9.1029 11.477C9.0206 11.7099 8.92818 11.9316 8.82797 12.1388C10.7613 11.4511 12.1925 9.70496 12.4218 7.59661H9.74679ZM5.1706 1.8616C3.23814 2.54963 1.80876 4.29604 1.5795 6.40376H4.25357C4.30224 4.91756 4.53083 3.56129 4.89746 2.5234C4.97968 2.29066 5.07051 2.0686 5.1706 1.8616ZM7.00018 1.54637C6.93213 1.54638 6.79503 1.5807 6.59898 1.81145C6.40332 2.04177 6.20139 2.41058 6.02136 2.92012C5.70754 3.80851 5.49461 5.02499 5.44643 6.40376H8.55394C8.50575 5.025 8.29282 3.80851 7.979 2.92012C7.79898 2.41059 7.59705 2.04177 7.40138 1.81145C7.20531 1.58067 7.06823 1.54637 7.00018 1.54637ZM8.82887 1.8616C8.92902 2.0687 9.02064 2.29053 9.1029 2.5234C9.46953 3.56129 9.69812 4.91756 9.74679 6.40376H12.4209C12.1916 4.29575 10.7618 2.54943 8.82887 1.8616Z"
      />
    </svg>
  )
}
