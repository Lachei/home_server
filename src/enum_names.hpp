#pragma once
#include <iostream>
#include <tuple>
#include <optional>

enum class Test{
    First,
    Second,
    Fourth,
    Fifth,
    COUNT
};

template<typename E, E V>
inline constexpr std::tuple<const char*, size_t> get_enum_val_name() {
    constexpr auto& pf = __PRETTY_FUNCTION__;
    constexpr size_t l = sizeof(pf);
    if (pf[l - 3] >= '0' && pf[l - 3] <= '9')
        return {};
    const char *r = pf + l - 1;
    for (;*(r - 1) != ':'; --r) {}
    return {r, (pf + l - 2) - r};
}
template<typename E, E V>
inline constexpr bool enum_contains_val_f() {
    constexpr auto& pf = __PRETTY_FUNCTION__;
    constexpr size_t l = sizeof(pf);
    return pf[l - 3] < '0' || pf[l - 3] > '9';
}

template<typename E, int ...I>
inline constexpr std::tuple<const char*, size_t> enum_to_name(E e, std::integer_sequence<int, I...>) {
    std::tuple<const char*, size_t> r{};
    (((int)e != I || (r = get_enum_val_name<E, (E)I>(), false)) && ...);
    return r;
}

template<typename E>
inline constexpr std::tuple<const char*, size_t> enum_name(E e) {
    return enum_to_name<E>(e, std::make_integer_sequence<int, (int)E::COUNT>());
}

inline bool comp_strings(const char *a, const std::tuple<const char*, size_t>& b) {
    for (int i = 0; i < std::get<1>(b); ++i)
        if (a[i] == '\0' || a[i] != std::get<0>(b)[i])
            return false;
    return a[std::get<1>(b)] == '\0';
}

template<typename E, int ...I>
inline std::optional<E> name_to_enum(const char *name, std::integer_sequence<int, I...>) {
    std::optional<E> r{};
    ((!enum_contains_val_f<E, (E)I>() || !comp_strings(name, enum_name((E)I)) || (r = {(E)I})) && ...);
    return r;
}

template<typename E>
inline std::optional<E> name_to_enum_val(const char * name) {
    return name_to_enum<E>(name, std::make_integer_sequence<int, (int)E::COUNT>());
}

template<typename E>
inline std::string enum_name_string(E e) {
    auto n = enum_name(e);
    if (!std::get<0>(n))
        return {"invalid enum value"};
    return std::string(std::get<0>(n), std::get<0>(n) + std::get<1>(n));
}

inline void test_name_to_enum(const char *name) {
    auto t = name_to_enum_val<Test>(name);
    if (t)
        std::cout << "Found enum " << enum_name_string(t.value()) << '\n';
    else
        std::cout << "Could not find enum " << name << '\n';

}

inline void test_enum_inflection() {
    std::cout << enum_name_string(Test::First) << '\n';
    std::cout << enum_name_string(Test::Second) << '\n';
    std::cout << enum_name_string(Test::Fourth) << '\n';
    std::cout << enum_name_string(Test::Fifth) << '\n';
    std::cout << enum_name_string(Test(12)) << '\n';
    
    test_name_to_enum("First");
    test_name_to_enum("first");
    test_name_to_enum("Second");
    test_name_to_enum("Secondd");
    test_name_to_enum("Third");
    test_name_to_enum("Fourth");
}
