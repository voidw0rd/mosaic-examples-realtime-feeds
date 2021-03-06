#!/dev/null

if ! test "${#}" -eq 0 ; then
	echo "[ee] invalid arguments; aborting!" >&2
	exit 1
fi

_npm_args+=(
		install .
)

if test "${#_npm_args[@]}" -eq 0 ; then
	exec env "${_npm_env[@]}" "${_npm_bin}"
else
	exec env "${_npm_env[@]}" "${_npm_bin}" "${_npm_args[@]}"
fi

exit 0
