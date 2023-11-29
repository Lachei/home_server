#include "utils.hpp"
#include "../src/util.hpp"

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

int main()
{
    check_res(test_string_serialization());

    return result::success;
}