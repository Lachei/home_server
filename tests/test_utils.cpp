#include "utils.hpp"
#include "../src/util.hpp"
#include "../src/string_split.hpp"

namespace result
{
    constexpr int error = 1;
}

int test_string_serialization()
{
    const auto t = std::chrono::utc_clock::now();
    const auto t_string = to_date_string(t);
    std::cout << t_string << std::endl;

    try
    {
        const auto t_parsed = from_date_string(t_string);
        std::cout << t_parsed << ", " << t << std::endl;

        if (t_parsed != t)
            return result::error;
    }
    catch (std::runtime_error e)
    {
        return result::error;
    }

    return result::success;
}

int test_js_time()
{
    const std::string_view date = "2023-11-30T18:00:00.000Z";
    const auto t = from_json_date_string(date);
    const auto t_s = to_json_date_string(t);
    std::cout << date << " | " << t_s << std::endl;
    if (date != t_s)
        return result::error;
    return result::success;
}

int test_string_split()
{
    std::string_view test = "Halloxxx mein besterxxx bam";
    std::string_view delim = "xxx";

    std::vector<std::string_view> elements{"Hallo", " mein bester", " bam"};
    uint32_t c{};
    for (auto p : string_split{test, delim})
    {
        std::cout << p << " | ";
        if (p != elements[c++])
            return result::error;
    }
    std::cout << std::endl;
    return result::success;
}

int main()
{
    check_res(test_string_serialization());
    check_res(test_string_split());
    check_res(test_js_time());

    return result::success;
}